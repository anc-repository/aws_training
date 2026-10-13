# scripts/release-docker/Dockerfile.builder — the Linux build environment of scripts/release (00-ec2-base 6.5, 01 §4.5).
# Same distribution and Node.js package as the L0 instance and the workstation (AL2023, dnf nodejs22), so native modules
# (better-sqlite3, sharp, @node-rs/argon2) are fetched or compiled for exactly the runtime that loads them.
# Built per platform by scripts/release-docker/build.sh: linux/amd64 natively, linux/arm64 through QEMU (binfmt).
#   docker build --platform linux/arm64 -f scripts/release-docker/Dockerfile.builder -t atl-release-builder:arm64 scripts/release-docker
ARG BASE_IMAGE=amazonlinux:2023
FROM ${BASE_IMAGE}
# git: package.ts lists sources with `git ls-files`; python3 / make / gcc-c++: node-gyp fallback when a prebuilt binary is
# unavailable; tar / gzip / findutils / coreutils: scripts/release; which / procps-ng / file: diagnostics.
RUN dnf -y install nodejs22 nodejs22-npm git tar gzip findutils which procps-ng file python3 make gcc-c++ \
 && alternatives --set node /usr/bin/node-22 \
 && dnf clean all && rm -rf /var/cache/dnf \
 && node --version && npm --version
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /work
