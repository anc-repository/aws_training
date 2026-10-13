#!/bin/bash
# /opt/atl/bin/atl-workstation-setup.sh — the only command of the SSM document ATL-WorkstationSetup (03 §4.6), run as root.
# Parameters arrive as environment variables SSM_SessionId, SSM_Region, SSM_AgentApiEndpoint, SSM_PlatformOrigin
# (interpolationType ENV_VAR) and are validated again here. Every other session fact comes from the agent context
# (atl.agent-context/v1), the single source shared with the runner. Idempotent: files are overwritten, never appended.
# Exit codes: 0 wired; 3 non-retryable rejection (bad parameter, 403/409, invalid context, incomplete platform env);
#             4 temporarily unavailable (bootstrap not finished, network, STS / IAM tag propagation).
set -uo pipefail
umask 022

log() { printf '%s atl-workstation-setup: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { log "$2"; exit "$1"; }

SID="${SSM_SessionId:-}"
REGION="${SSM_Region:-}"
API="${SSM_AgentApiEndpoint:-}"
ORIGIN="${SSM_PlatformOrigin:-}"
[ -n "$SID$REGION$API$ORIGIN" ] || fail 3 "no SSM_* parameters (SSM Agent too old for interpolationType ENV_VAR?)"
[[ "$SID" =~ ^s[0-9a-hjkmnp-tv-z]{12}$ ]] || fail 3 "invalid SessionId"
[[ "$REGION" =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]] || fail 3 "invalid Region"
[[ "$API" =~ ^https://[a-z0-9]{10}\.execute-api\.[a-z]{2}-[a-z]+-[0-9]\.amazonaws\.com$ ]] || fail 3 "invalid AgentApiEndpoint"
[[ "$ORIGIN" =~ ^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || fail 3 "invalid PlatformOrigin"

[ -f /var/lib/atl/installed.json ] || fail 4 "the workstation bootstrap (user data) has not finished yet"
id labuser >/dev/null 2>&1 || fail 4 "labuser does not exist yet"
LH=/home/labuser
as_labuser() { sudo -u labuser -H env HOME="$LH" AWS_CONFIG_FILE="$LH/.aws/config" AWS_SDK_LOAD_CONFIG=1 "$@"; }

# ---- 1. learner CLI profile (role chain ATLWorkstationRole → ATLLearnerRole as atl-<sid>-ws, 01 §6.3) ----
imds_token=$(curl -sS -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 120' 2>/dev/null) ||
  fail 4 "IMDS is not reachable"
ACCT=$(curl -sS -m 3 -H "X-aws-ec2-metadata-token: ${imds_token}" http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .accountId)
[[ "$ACCT" =~ ^[0-9]{12}$ ]] || fail 4 "cannot read the account id from the instance identity document"
install -d -m 0700 -o labuser -g labuser "$LH/.aws" "$LH/.atl" "$LH/.ssh" "$LH/.cache" "$LH/.cache/atl"
cat > "$LH/.aws/config.tmp" <<EOF
[default]
role_arn = arn:aws:iam::${ACCT}:role/ATLLearnerRole
credential_source = Ec2InstanceMetadata
role_session_name = atl-${SID}-ws
region = ${REGION}
duration_seconds = 3600
cli_pager =
EOF
chown labuser:labuser "$LH/.aws/config.tmp" && chmod 0600 "$LH/.aws/config.tmp" && mv "$LH/.aws/config.tmp" "$LH/.aws/config"
log "learner CLI profile written (atl-${SID}-ws)"

# ---- 2. agent context (only the context route accepts PROVISIONING, 01 §5.3) ----
ctx=$(mktemp /tmp/atl-context.XXXXXX)
chown labuser "$ctx"
as_labuser /opt/atl/bin/atl-agent-call --endpoint "$API" GET "/api/v1/agent/sessions/${SID}/context" > "$ctx"
rc=$?
case "$rc" in
  0) ;;
  3) rm -f "$ctx"; fail 3 "the platform rejected the context request (caller or session state)" ;;
  2) rm -f "$ctx"; fail 3 "atl-agent-call usage error" ;;
  *) rm -f "$ctx"; fail 4 "the agent context is not available yet" ;;
esac

# ---- 3. /etc/atl/session.env (0644, non-secret) and 4. ~labuser/.atl/session.json (0600) ----
/opt/atl/bin/atl-write-session-files "$ctx" --env /etc/atl/session.env --json "$LH/.atl/session.json"
rc=$?
if [ "$rc" -ne 0 ]; then
  rm -f "$ctx"
  [ "$rc" -eq 3 ] && fail 3 "the agent context was rejected (unknown schema or missing field)"
  fail 4 "could not write the session files"
fi
chmod 0644 /etc/atl/session.env
chown labuser:labuser "$LH/.atl/session.json" && chmod 0600 "$LH/.atl/session.json"
ENV_NAME=$(jq -r .envName "$ctx")
SSH_KEY_PARAM=$(jq -r '.ssh.keyParam // empty' "$ctx")
SSH_USER=$(jq -r '.ssh.user // "ec2-user"' "$ctx")
CTX_SCHEMA=$(jq -r .schema "$ctx")
rm -f "$ctx"
log "session.env and session.json written (env ${ENV_NAME})"

repo="$LH/cloudalbum"
module_cmd() { as_labuser bash -lc "cd '$repo' && scripts/module $*"; }
if [ -x "$repo/scripts/module" ]; then
  # self-check of the platform-mode environment (06 PM-26): exit 2 + PLATFORM_ENV_INCOMPLETE = wiring failure
  out=$(module_cmd --platform status --json 2>&1)
  rc=$?
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q PLATFORM_ENV_INCOMPLETE; then
    log "$out"
    fail 3 "scripts/module reports PLATFORM_ENV_INCOMPLETE"
  fi
  # ---- 3a. pending platform hooks as the learner (06 PM-36); failures keep the hook pending, wiring continues ----
  if ! module_cmd hooks run --pending --platform >/var/lib/atl/hooks.log 2>&1; then
    log "pending hooks did not complete (they stay pending; see /var/lib/atl/hooks.log)"
  fi
fi

# ---- 5. SSH to the lab instance (only when the card declares sshFromWorkstation) ----
if [ -n "$SSH_KEY_PARAM" ]; then
  key="$LH/.ssh/atl-${ENV_NAME}.pem"
  if as_labuser aws ssm get-parameter --region "$REGION" --name "$SSH_KEY_PARAM" --with-decryption \
      --query Parameter.Value --output text > "${key}.tmp" 2>/var/lib/atl/ssh-key.err; then
    chown labuser:labuser "${key}.tmp" && chmod 0600 "${key}.tmp" && mv "${key}.tmp" "$key"
    cat > "$LH/.ssh/config.tmp" <<EOF
Host lab
  User ${SSH_USER}
  IdentityFile ~/.ssh/atl-${ENV_NAME}.pem
  ProxyCommand /opt/atl/bin/atl-lab-proxy %p
  HostKeyAlias atl-lab-${ENV_NAME}
  UserKnownHostsFile ~/.ssh/known_hosts_atl
  StrictHostKeyChecking accept-new
EOF
    chown labuser:labuser "$LH/.ssh/config.tmp" && chmod 0600 "$LH/.ssh/config.tmp" && mv "$LH/.ssh/config.tmp" "$LH/.ssh/config"
    log "ssh lab configured"
  else
    rm -f "${key}.tmp"
    fail 4 "could not read the session SSH key ${SSH_KEY_PARAM}"
  fi
fi

# ---- 6. the CloudAlbum admin password is never written to disk (read on demand from adminPasswordParam) ----

# ---- 7. readiness report for the health gate ws.ready (read by ATL-RunCheck) ----
caller=$(as_labuser aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)
cli_ok=false
[[ "$caller" == *":assumed-role/ATLLearnerRole/atl-${SID}-ws" ]] && cli_ok=true
aws_v=$(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2)
node_v=$(node --version 2>/dev/null || true)
k6_v=$(k6 version 2>/dev/null | awk '{print $2}' || true)
plugin_v=$(session-manager-plugin --version 2>/dev/null || true)
commit=$(jq -r '.repoCommit // empty' /var/lib/atl/installed.json 2>/dev/null || true)
jq -n --arg sid "$SID" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg schema "$CTX_SCHEMA" --argjson cliOk "$cli_ok" \
  --arg aws "$aws_v" --arg node "$node_v" --arg k6 "$k6_v" --arg plugin "$plugin_v" --arg commit "$commit" \
  '{schema: "atl.ws-ready/v1", sessionId: $sid, wiredAt: $at, contextSchema: $schema, labuserPresent: true,
    cliProfileOk: $cliOk, repoCommit: $commit, tools: {awsCli: $aws, node: $node, k6: $k6, sessionManagerPlugin: $plugin}}' \
  > /var/lib/atl/ready.json.tmp && mv /var/lib/atl/ready.json.tmp /var/lib/atl/ready.json
[ "$cli_ok" = true ] || log "warning: the learner profile does not resolve to atl-${SID}-ws yet (got: ${caller:-nothing})"
log "workstation wired to ${SID}"
exit 0
