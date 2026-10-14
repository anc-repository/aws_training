# target: server
# defaults: DNS_CANONICAL_REDIRECT=off DNS_RECORD_NAME=invalid.invalid APP_BASE_URL=http://invalid.invalid
# /etc/nginx/cloudalbum.server.d/dns-canonical.conf — rendered by run-hostsetup.sh from infra/modules/dns/nginx/dns-canonical.conf.tpl
# (registry nginxFragments of dns; values from modules.d/dns.env; 80/443 server block only, the cdn 8080 listener never
# includes cloudalbum.server.d). DNS_CANONICAL_REDIRECT=on: requests whose Host is not the record name (EIP, EC2 public DNS
# name) get a 301 to APP_BASE_URL. Never redirected (01#dns section 9): /api/health/* (ALB / Route 53 health checks must see
# the real status), ACME HTTP-01, the local health endpoints under /_ca/, and loopback ($realip_remote_addr is the TCP peer:
# the platform's local checks use http://127.0.0.1/). With the default off the fragment only sets a variable.
# Module variables use the $ca_dns_* prefix (00-ec2-base.md 6.7 rule 2); infra/modules/dns/host-setup.sh validates the values.
set $ca_dns_canonical "${DNS_CANONICAL_REDIRECT}";
if ($host = "${DNS_RECORD_NAME}") { set $ca_dns_canonical off; }
if ($uri ~ "^/(api/health/|\.well-known/acme-challenge/|_ca/)") { set $ca_dns_canonical off; }
if ($realip_remote_addr ~ "^(127\.|::1$)") { set $ca_dns_canonical off; }
if ($ca_dns_canonical = on) { return 301 ${APP_BASE_URL}$request_uri; }
