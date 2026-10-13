# defaults: CDN_ORIGIN_PORT=8080
# /etc/nginx/cloudalbum.d/cdn-origin.conf — rendered by run-hostsetup.sh from infra/modules/cdn/nginx/cdn-origin.conf.tpl
# (registry nginxFragments of cdn; placeholders come from modules.d/cdn.env). Only the CloudFront origin listener:
# no secrets here and no map definitions ($ca_cdn_verified comes from 00-entry.conf + slot-origin-verify.inc).
server {
    listen ${CDN_ORIGIN_PORT};
    server_name _;
    server_tokens off;

    # CloudFront origin-facing ranges (cloudalbum-cdn-cf-ranges.timer refreshes them daily; .inc = never globbed at http level)
    include /etc/nginx/cloudalbum.d/cdn-realip-ranges.inc;
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;

    # JS / CSS are compressed at the edge (br / gzip); API JSON is still gzipped here (CachingDisabled behaviours are not compressed by the edge)
    gzip_types application/json;
    access_log /var/lib/cloudalbum/logs/nginx-access.json cloudalbum_json;
    client_max_body_size 30m;

    # 00-ec2-base.md 6.7 rule 3: 8080 does not inherit the three checks of the 80/443 server block
    if ($ca_cdn_verified = 0) { return 403; }
    if ($ca_denied) { return 403; }
    if ($ca_block)  { return 403; }

    root /opt/cloudalbum/frontend/dist;
    include /etc/nginx/cloudalbum_locations.conf;
}
