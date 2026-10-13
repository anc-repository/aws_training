# ATL check bundle (`platform/checks`)

The lab-side half of the ATL check engine (docs/platform/04 §6): the only program the SSM document `ATL-RunCheck`
runs. It observes and reports facts; every verdict is made by `atl-checks` on the platform side.

```
bin/atl-check          launcher installed at /opt/atl/bin/atl-check (bash): re-checks the SSM_* parameters with the
                       document's allowedPattern, selects /opt/atl/checks/<BundleDigest>/, recomputes the manifest
                       digest, execs `node runner.mjs`
bin/atl-check.mjs      the same launcher in Node, for ATL_DEV_MODE (ATL_DEV_CHECK_RUNNER) and tests; not installed
src/runner.mjs         re-validates parameters, verifies the SHA-256 of every manifest file, decodes ArgsB64 (single
                       item or `batch` of ≤ 10), validates args against schemas/<checkId>.args.json, runs the check,
                       prints one `ATL-RESULT-V1 <base64url(JSON)>` line per item (≤ 16 KB, arrays truncated)
src/checks/<id>.mjs    one module per checkId of 04 §6.4 (25 ids; aliases atl.capabilities, atl.lab-metrics,
                       cloudalbum-probe-token) — read-only, fixed argv via execFile, never a shell
src/args-schemas.mjs   the args schema of every checkId (written to schemas/*.args.json by the build)
src/lib/               host context (CloudAlbum CLI of 06 PM-12, IMDSv2, probe tokens), HTTP probe, capabilities,
                       result lines, schema validator — Node built-ins only
build.mjs              builds the bundle
```

## Build

```bash
node platform/checks/build.mjs [--out <dir>] [--created-at <ISO>]   # default out: platform/checks/dist
```

Output (the layout of the CloudAlbum release archive, 06 PM-04):

```
<out>/atl/bin/atl-check                       → /opt/atl/bin/atl-check (0755)
<out>/atl/checks/<bundleDigest>/manifest.json → /opt/atl/checks/<bundleDigest>/ (root:root, files 0644)
<out>/atl/checks/<bundleDigest>/{runner.mjs, args-schemas.mjs, lib/*, checks/*, schemas/*}
<out>/atl/bin/atl-check.mjs                   dev / test launcher (not part of the release)
<out>/bundle.json                             { bundleDigest, version, createdAt, checks[] }
```

`bundleDigest` = SHA-256 of `manifest.json` = the directory name. `scripts/release` copies `<out>/atl/bin/atl-check` and
`<out>/atl/checks/` into `atl/` of `cloudalbum-<ver>-<arch>.tgz` and writes `atlBundleDigest` into
`.release-manifest.json`; the platform release registers the same digest (`PlatformConfig.checks.bundleDigest` or the
function variable `ATL_CHECK_BUNDLE_DIGEST`), and atl-checks passes it as `BundleDigest` on every call. Set
`SOURCE_DATE_EPOCH` (or `--created-at`) for a reproducible digest.

## Dev mode

```bash
node platform/checks/build.mjs
export ATL_DEV_CHECK_RUNNER=$PWD/platform/checks/dist/atl/bin/atl-check.mjs   # LocalRunCommand runs it per call
```

With `ATL_DEV_MODE=1` the checks talk to the local CloudAlbum of the environment (`ATL_DEV_APP_BASE_URL`,
`ATL_DEV_APP_ROOT/etc` for modules.d, platform.env, probe token) instead of `/etc/cloudalbum` and `127.0.0.1:80`; host-only
facts (systemd, ss, IMDS, sshd) are faked and marked `dev: true`. The dev check engine reads the digest from
`dist/bundle.json`.

## Running a check by hand on an instance (07 V3-3 step 4)

```bash
sudo SSM_CheckId=atl.capabilities SSM_ArgsB64=e30 SSM_RunToken=manualrun0000000000000 SSM_SessionId=svrfy00000031 \
     SSM_BundleDigest=<digest> SSM_TimeoutSec=20 /opt/atl/bin/atl-check
```
