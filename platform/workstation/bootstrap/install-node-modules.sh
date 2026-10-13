#!/bin/bash
# install-node-modules.sh <repo dir> — node_modules for the repository subset shipped to the workstation and the runner
# (cloudalbum-src.tar.gz / cloudalbum-infra.zip: packages/*, scripts/module-cli, scripts/labs, experiments, platform/shared).
# Shipped in atl-workstation.tar.gz as atl-install-node-modules.sh. Used twice with the same result:
#   - scripts/release-docker/build.sh, in an arm64 AL2023 container, to prebuild the set that the bundle carries;
#   - atl-ws-install.sh at boot when the bundle has no node_modules for this machine (then it needs the npm registry).
# Installs the dependencies of the workspaces that exist in the subset plus tsx (`npm run exp` runs the experiments through
# it), with the repository's package-lock.json pinning every version. The root package.json lists workspaces that are not
# shipped (backend, frontend, platform/api, …): npm resolves against a temporary copy restricted to the present ones, and
# the original package.json / package-lock.json are put back afterwards.
set -euo pipefail
R=${1:?usage: install-node-modules.sh <repo dir>}
cd "$R"
[ -f package.json ] && [ -f package-lock.json ] || { echo "install-node-modules: $R has no package.json / package-lock.json" >&2; exit 2; }
cp -p package.json .atl-package.json.orig
cp -p package-lock.json .atl-package-lock.json.orig
restore() { mv -f .atl-package.json.orig package.json; mv -f .atl-package-lock.json.orig package-lock.json; }
trap restore EXIT
node -e '
  const fs = require("node:fs"), path = require("node:path");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const present = [];
  for (const w of pkg.workspaces || []) {
    if (w.endsWith("/*")) {
      const base = w.slice(0, -2);
      if (!fs.existsSync(base)) continue;
      for (const n of fs.readdirSync(base).sort()) if (fs.existsSync(path.join(base, n, "package.json"))) present.push(`${base}/${n}`);
    } else if (fs.existsSync(path.join(w, "package.json"))) present.push(w);
  }
  if (!present.length) { console.error("install-node-modules: no workspace of package.json is present"); process.exit(2); }
  const keepDev = ["tsx"];
  pkg.workspaces = present;
  pkg.devDependencies = Object.fromEntries(keepDev.filter((d) => pkg.devDependencies?.[d]).map((d) => [d, pkg.devDependencies[d]]));
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  console.log(`install-node-modules: workspaces ${present.join(", ")} + ${keepDev.join(", ")}`);
'
npm install --no-audit --no-fund --loglevel=warn
# the runtime set as installed (the original manifests come back on exit)
cp package.json node_modules/.atl-runtime-package.json
