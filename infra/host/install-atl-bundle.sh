#!/bin/bash
# infra/host/install-atl-bundle.sh — install the ATL check bundle shipped in the CloudAlbum release (06 PM-04; root, idempotent).
# Called by l0-bootstrap.sh (install phase, both modes), by the golden AMI build, and by `cloudalbum atl-bundle:install` (repair).
#   release layout: <release>/atl/bin/atl-check, <release>/atl/checks/<bundleDigest>/{manifest.json,runner.mjs,…}
#   1. /opt/atl, /opt/atl/bin, /opt/atl/checks owned by root 0755
#   2. copy atl/checks/<digest>/ (skipped when it exists and manifest.json hashes to <digest>); files root:root 0644, dirs 0755
#   3. install atl/bin/atl-check (temporary file + rename)
#   4. recompute the manifest digest: it must equal the directory name (and .release-manifest.json atlBundleDigest)
#   5. keep only the 3 most recent digest directories (by mtime): a reused environment can still run the previous bundle
# /opt/atl, /etc/atl, /var/lib/atl and labuser belong to the platform (03 §3.4): this script is CloudAlbum's only write there.
set -euo pipefail

REL=${ATL_RELEASE_DIR:-/opt/cloudalbum}
DEST=${ATL_ROOT_DIR:-/opt/atl}
SRC=$REL/atl

json() { printf '%s\n' "$1"; }
[ "$(id -u)" = 0 ] || [ -n "${ATL_ROOT_DIR:-}" ] || { json '{"error":{"code":"ROOT_REQUIRED","message":"atl-bundle:install must run as root"}}'; exit 2; }
if [ ! -d "$SRC/checks" ] || [ ! -f "$SRC/bin/atl-check" ]; then
  json '{"installed":[],"skipped":"the release does not ship a check bundle"}'
  exit 0
fi

own() { if [ "$(id -u)" = 0 ]; then chown -R root:root "$@"; fi; }
install -d -m 0755 "$DEST" "$DEST/bin" "$DEST/checks"
own "$DEST"

digest_of() { sha256sum "$1/manifest.json" | cut -c1-64; }

# every file listed in manifest.json must match its sha256 (the launcher re-checks this before each run: RUNNER_INTEGRITY)
files_ok() {
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    const dir = process.argv[1];
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    for (const [rel, want] of Object.entries(m.files || {})) {
      const got = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
      if (got !== want) { console.error("install-atl-bundle: " + rel + " does not match manifest.json"); process.exit(1); }
    }
  ' "$1"
}

installed=()
for d in "$SRC"/checks/*/; do
  digest=$(basename "$d")
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || continue
  [ "$(digest_of "$d")" = "$digest" ] || { echo "install-atl-bundle: $digest: manifest digest mismatch in the release" >&2; exit 5; }
  files_ok "$d" || exit 5
  target=$DEST/checks/$digest
  if [ -f "$target/manifest.json" ] && [ "$(digest_of "$target")" = "$digest" ] && files_ok "$target" 2>/dev/null; then
    touch "$target"; installed+=("$digest"); continue
  fi
  tmp=$DEST/checks/.tmp.$digest.$$
  rm -rf "$tmp"
  cp -R "$d" "$tmp"
  own "$tmp"
  find "$tmp" -type d -exec chmod 0755 {} +
  find "$tmp" -type f -exec chmod 0644 {} +
  [ "$(digest_of "$tmp")" = "$digest" ] || { rm -rf "$tmp"; echo "install-atl-bundle: copy of $digest is corrupt" >&2; exit 5; }
  rm -rf "$target"
  mv -T "$tmp" "$target"
  installed+=("$digest")
done

tmpbin=$(mktemp "$DEST/bin/.atl-check.XXXXXX")
cp "$SRC/bin/atl-check" "$tmpbin"
chmod 0755 "$tmpbin"; own "$tmpbin"
mv -f "$tmpbin" "$DEST/bin/atl-check"

# step 4: the digest registered in the release manifest must be installed and intact
want=''
if [ -f "$REL/.release-manifest.json" ]; then
  want=$(tr -d '\n' < "$REL/.release-manifest.json" | sed -n 's/.*"atlBundleDigest"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{64\}\)".*/\1/p')
fi
if [ -n "$want" ]; then
  [ -f "$DEST/checks/$want/manifest.json" ] && [ "$(digest_of "$DEST/checks/$want")" = "$want" ] \
    || { echo "install-atl-bundle: release digest $want is not installed correctly" >&2; exit 5; }
  touch "$DEST/checks/$want"
fi

# step 5: keep the 3 most recent digest directories
mapfile -t all < <(ls -1dt "$DEST"/checks/*/ 2>/dev/null | sed 's:/*$::')
for old in "${all[@]:3}"; do
  [[ $(basename "$old") =~ ^[a-f0-9]{64}$ ]] && rm -rf "$old"
done

printf '{"installed":['
first=1
for d in "${installed[@]}"; do [ $first = 1 ] || printf ','; printf '"%s"' "$d"; first=0; done
printf '],"releaseDigest":%s}\n' "$( [ -n "$want" ] && printf '"%s"' "$want" || printf null)"
