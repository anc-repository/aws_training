#!/bin/bash
# scripts/release-docker/in-container.sh <phase> — the steps scripts/release-docker/build.sh runs inside the builder
# containers (Dockerfile.builder: amazonlinux:2023 + nodejs22). Mounts: /xfer = the work directory (src.bundle, overlay.tar,
# intermediates, logs), /out = the output directory (app/, <tag>/), /root/.npm = the npm cache of that architecture.
# Everything is built in the container's own file system (/work); only results are copied to /xfer and /out.
#   build       (linux/amd64)  clone the bundle → npm ci → build, frontend, web, content, check bundle → scripts/release
#                              --prepare-only → x86_64 archive → prepared stage + source subset for the arm64 steps
#   arch <a>    (linux/<a>)    scripts/release --from-prepared for <a> (native or QEMU), native modules loaded
#   ws-modules  (linux/arm64)  node_modules for the workstation (symlinks kept) and the runner (regular files only)
#   package     (linux/amd64)  npm run platform:package with every input, then preflight --artifacts-only on the result
set -euo pipefail
phase=${1:?usage: in-container.sh build | arch <arm64|x86_64> | ws-modules | package [platform:package args…]}; shift
log() { printf '[%s %s] %s\n' "$(date -u +%H:%M:%S)" "$phase" "$*"; }
tarz() {   # deterministic tar.gz of <dir> <member…> to stdout (GNU tar)
  local dir=$1; shift
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${SOURCE_DATE_EPOCH:-0}" "${TAR_EXTRA[@]}" -C "$dir" -cf - "$@" | gzip -n -9
}
TAR_EXTRA=()

case "$phase" in
build)
  rm -rf /work/src && git clone -q /xfer/in/src.bundle /work/src
  cd /work/src
  git checkout -q --detach "$(cat /xfer/in/REF)"
  if [ -f /xfer/in/overlay.tar ]; then log "overlay: $(tar -tf /xfer/in/overlay.tar | grep -vc '/$') files from the working tree"; tar -xf /xfer/in/overlay.tar; fi
  COMMIT=$(git rev-parse HEAD)
  export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
  VERSION=${REL_VERSION:-$(node -p 'require("./package.json").version')-g$(git rev-parse --short=7 HEAD)}
  log "commit $COMMIT, CloudAlbum $VERSION, platform $(cat platform/VERSION), SOURCE_DATE_EPOCH $SOURCE_DATE_EPOCH, node $(node --version), npm $(npm --version)"
  npm ci --no-audit --no-fund --loglevel=warn
  log "npm ci done"
  npm run build
  npm run build:frontend
  npm run build:web
  npm run labs:build
  node platform/checks/build.mjs >/dev/null
  log "builds done (check bundle $(node -p 'require("./platform/checks/dist/bundle.json").bundleDigest'))"
  rm -rf /work/rel && mkdir -p /work/rel /out/app /xfer/tools
  scripts/release "$VERSION" --skip-build --prepare-only --out /work/rel
  scripts/release "$VERSION" --arch x86_64 --from-prepared "/work/rel/cloudalbum-$VERSION-prepared" --out /work/rel
  cp "/work/rel/cloudalbum-$VERSION-x86_64.tgz" "/work/rel/cloudalbum-$VERSION-x86_64.tgz.sha256" /out/app/
  tar -C /work/rel -cf /xfer/prepared.tar "cloudalbum-$VERSION-prepared"
  cp scripts/release platform/workstation/bootstrap/install-node-modules.sh /xfer/tools/
  npx --no-install tsx platform/infra/build/package.ts --emit-source /xfer/ws-src.tar.gz
  printf '%s\n' "$VERSION" > /xfer/VERSION; printf '%s\n' "$COMMIT" > /xfer/COMMIT; printf '%s\n' "$SOURCE_DATE_EPOCH" > /xfer/SOURCE_DATE_EPOCH
  log "x86_64 archive and the prepared stage are ready" ;;

arch)
  arch=${1:?arch <arm64|x86_64>}
  VERSION=$(cat /xfer/VERSION); export SOURCE_DATE_EPOCH; SOURCE_DATE_EPOCH=$(cat /xfer/SOURCE_DATE_EPOCH)
  log "$(uname -m), node $(node --version), CloudAlbum $VERSION"
  rm -rf /work/rel && mkdir -p /work/rel /out/app && tar -C /work/rel -xf /xfer/prepared.tar
  bash /xfer/tools/release "$VERSION" --arch "$arch" --from-prepared "/work/rel/cloudalbum-$VERSION-prepared" --out /work/rel
  cp "/work/rel/cloudalbum-$VERSION-$arch.tgz" "/work/rel/cloudalbum-$VERSION-$arch.tgz.sha256" /out/app/
  log "$arch archive ready" ;;

ws-modules)
  export SOURCE_DATE_EPOCH; SOURCE_DATE_EPOCH=$(cat /xfer/SOURCE_DATE_EPOCH)
  m=$(uname -m); case "$m" in aarch64) a=arm64 ;; x86_64) a=x86_64 ;; *) a=$m ;; esac
  rm -rf /work/ws && mkdir -p /work/ws && tar -C /work/ws -xzf /xfer/ws-src.tar.gz
  bash /xfer/tools/install-node-modules.sh /work/ws
  # what the workstation and the runner run: scripts/module (module-cli dist), the experiments runner through tsx, natives
  ( cd /work/ws
    ./scripts/module --help >/dev/null
    npm run -s exp -- --help >/dev/null
    node -e '
      const { createRequire } = require("node:module");
      const r = createRequire(process.cwd() + "/scripts/module-cli/package.json");
      const argon2 = r("@node-rs/argon2");
      const sharp = createRequire(process.cwd() + "/experiments/package.json")("sharp");
      Promise.all([argon2.hash("x"), sharp({ create: { width: 1, height: 1, channels: 3, background: "#000" } }).png().toBuffer()])
        .then(() => console.log("ws-modules: argon2 and sharp load on " + process.arch))
        .catch((e) => { console.error(e); process.exit(1); });
    ' )
  info() {  # sidecar <file>.json read by build/package.ts (nodeModulesInfo)
    node -e '
      const fs = require("node:fs"), crypto = require("node:crypto");
      const [file, kind, arch, files] = process.argv.slice(1);
      const lock = fs.readFileSync("/work/ws/package-lock.json");
      fs.writeFileSync(file + ".json", JSON.stringify({ schema: "atl.node-modules/v1", kind, arch, platform: `linux-${arch}`,
        node: process.version, npm: require("child_process").execSync("npm --version").toString().trim(),
        createdAt: new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString(), sourceCommit: fs.readFileSync("/xfer/COMMIT", "utf8").trim(),
        lockSha256: crypto.createHash("sha256").update(lock).digest("hex"), files: Number(files),
        sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") }, null, 2) + "\n");
    ' "$@"
  }
  # workstation: extracted into the repository, workspace links and .bin links kept
  f=/xfer/cloudalbum-node_modules-linux-$a.tar.gz
  tarz /work/ws node_modules > "$f"
  info "$f" workstation "$a" "$(find /work/ws/node_modules -type f | wc -l)"
  # runner: ZIP has no links → dereference the workspace links, drop .bin (scripts/module is started by path)
  f=/xfer/runner-node_modules-linux-$a.tar.gz
  TAR_EXTRA=(--dereference --exclude=.bin)
  tarz /work/ws node_modules > "$f"
  TAR_EXTRA=()
  info "$f" runner "$a" "$(tar -tzf "$f" | grep -vc '/$')"
  ls -l /xfer/*node_modules-linux-"$a".tar.gz
  log "node_modules ready" ;;

package)
  cd /work/src
  VERSION=$(cat /xfer/VERSION); export SOURCE_DATE_EPOCH; SOURCE_DATE_EPOCH=$(cat /xfer/SOURCE_DATE_EPOCH)
  TAG=v$(cat platform/VERSION)
  OUT=/out/$TAG
  content=$(ls -td dist/content/*/ | head -1); content=${content%/}
  args=(--tag "$TAG" --out "$OUT" --checks-dir "$PWD/platform/checks/dist/atl" --content-dir "$PWD/$content" --web-dir "$PWD/platform/web/dist")
  for a in x86_64 arm64; do
    if [ -f "/out/app/cloudalbum-$VERSION-$a.tgz" ]; then args+=(--app-archive "$a=/out/app/cloudalbum-$VERSION-$a.tgz"); fi
  done
  if [ -f /xfer/cloudalbum-node_modules-linux-arm64.tar.gz ]; then args+=(--workstation-node-modules /xfer/cloudalbum-node_modules-linux-arm64.tar.gz); fi
  if [ -f /xfer/runner-node_modules-linux-arm64.tar.gz ]; then args+=(--runner-node-modules /xfer/runner-node_modules-linux-arm64.tar.gz); fi
  npm run platform:package -- "${args[@]}" "$@"
  log "release layout in $OUT"
  node scripts/verify/preflight.mjs --artifacts-only --release-dir "$OUT" || log "preflight reported failures (see above)"
  node scripts/verify/preflight.mjs --artifacts-only --release-dir "$OUT" --json > /xfer/preflight-artifacts.json || true ;;

*) echo "unknown phase $phase" >&2; exit 64 ;;
esac
