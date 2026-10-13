/**
 * The inline policy `ATLRevokedSessions` on ATLLearnerRole (02 §6.3) as a pure function of the revocation state, and
 * back. `aws:userid` of an assumed-role session is `<role id>:<session name>`, so `*:atl-<sid>-*` covers the console,
 * terminal and workstation channels of a session.
 */
import { REVOKED_SESSIONS_STATEMENTS } from '@atl/shared';
import type { RevocationState } from './port.js';

const [REVOKED_SID, FINALIZING_SID] = REVOKED_SESSIONS_STATEMENTS;

export interface PolicyDocument {
  Version: '2012-10-17';
  Statement: Record<string, unknown>[];
}

/** `arn:aws:execute-api:<region>:<acct>:<apiId>/$default/PUT/api/v1/agent/sessions/<sid>/experiment-runs/*\/result` (04 §7.2). */
export function uploadExemptResource(q: { region: string; accountId: string; agentApiEndpoint: string; sid: string }): string {
  const m = /^https:\/\/([a-z0-9]+)\.execute-api\./.exec(q.agentApiEndpoint);
  const apiId = m ? m[1] : '*';
  return `arn:aws:execute-api:${q.region}:${q.accountId}:${apiId}/$default/PUT/api/v1/agent/sessions/${q.sid}/experiment-runs/*/result`;
}

export function revocationPolicy(state: RevocationState): PolicyDocument | null {
  const revoked = Object.keys(state.revoked).sort();
  const statements: Record<string, unknown>[] = [];
  if (revoked.length) {
    statements.push({
      Sid: REVOKED_SID,
      Effect: 'Deny',
      Action: '*',
      Resource: '*',
      Condition: { StringLike: { 'aws:userid': revoked.map((sid) => `*:atl-${sid}-*`) } },
    });
  }
  if (state.finalizing) {
    statements.push({
      Sid: FINALIZING_SID,
      Effect: 'Deny',
      Action: '*',
      NotResource: state.finalizing.exemptResource,
      Condition: { StringLike: { 'aws:userid': `*:atl-${state.finalizing.sid}-*` } },
    });
  }
  return statements.length ? { Version: '2012-10-17', Statement: statements } : null;
}

/**
 * Parse a policy back. Revocation times are not part of the policy; they are kept in the statement-independent
 * `Sid`-free metadata of the platform (here: unknown times read as the epoch, the sweeper uses CredentialGrant expiries).
 */
export function parseRevocationPolicy(doc: PolicyDocument | null, times: Record<string, string> = {}): RevocationState {
  const state: RevocationState = { revoked: {}, finalizing: null };
  for (const st of doc?.Statement ?? []) {
    const cond = (st.Condition as { StringLike?: Record<string, string | string[]> } | undefined)?.StringLike?.['aws:userid'];
    const patterns = Array.isArray(cond) ? cond : cond ? [cond] : [];
    const sids = patterns.map((p) => /^\*:atl-(s[0-9a-z]{12})-\*$/.exec(p)?.[1]).filter((x): x is string => !!x);
    if (st.Sid === REVOKED_SID) for (const sid of sids) state.revoked[sid] = times[sid] ?? new Date(0).toISOString();
    if (st.Sid === FINALIZING_SID && sids[0]) {
      state.finalizing = { sid: sids[0], since: times[sids[0]] ?? new Date(0).toISOString(), exemptResource: String(st.NotResource ?? '') };
    }
  }
  return state;
}
