# scripts/release-docker/drill/Dockerfile — the "instance" of the L0 offline install drill (scripts/release-docker/drill.sh).
# amazonlinux:2023 plus what an AL2023 AMI has and the container image lacks (systemd as PID 1 with systemd-udev — it ships
# systemd-fsck@.service, which the fstab entry of the data volume pulls in —, tar / gzip — the User Data
# stub extracts l0-bootstrap.sh with tar before anything is installed —, util-linux, iproute, procps, openssh-server,
# aws-cfn-bootstrap) and the drill's own tooling (python3: mock IMDS and the archive server; nftables: redirects
# 169.254.169.254 to the mock; createrepo_c: the offline package repository). Nothing the bootstrap installs is pre-installed
# here except nftables (needed before the bootstrap runs; the bootstrap line that also names it falls back anyway).
ARG BASE_IMAGE=amazonlinux:2023
FROM ${BASE_IMAGE}
RUN dnf -y install systemd systemd-udev tar gzip util-linux iproute procps-ng openssh-server nftables python3 aws-cfn-bootstrap createrepo_c \
      findutils hostname \
 && dnf clean all && rm -rf /var/cache/dnf
# stand-ins that make every AWS contact visible instead of performed:
#   cfn-signal → records its arguments (the real one would call CloudFormation SignalResource)
#   aws        → records its arguments and fails (the http AppArchiveUrl path must not need the AWS CLI)
#   swapon     → no-op: a container cannot enable swap on overlayfs, and swap would belong to the Docker VM kernel
COPY stubs/cfn-signal /opt/aws/bin/cfn-signal
COPY stubs/aws /usr/local/bin/aws
COPY stubs/swapon /usr/local/sbin/swapon
RUN chmod 0755 /opt/aws/bin/cfn-signal /usr/local/bin/aws /usr/local/sbin/swapon \
 && systemctl mask systemd-udevd.service systemd-udevd-control.socket systemd-udevd-kernel.socket \
      systemd-logind.service getty.target console-getty.service systemd-firstboot.service \
      systemd-networkd-wait-online.service systemd-remount-fs.service 2>/dev/null || true
# (systemd-networkd-wait-online would wait for a network that --network none never brings up; on EC2 the network is online
#  before the User Data runs, so units ordered after network-online.target — chrony-config / chronyd — start at once there.
#  systemd-remount-fs fails on the image's `LABEL=/` fstab line: the container's / is an overlay, not a labelled volume.)
STOPSIGNAL SIGRTMIN+3
CMD ["/usr/sbin/init"]
