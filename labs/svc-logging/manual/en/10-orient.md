---
step: orient
---

First, get a clear view of the starting point: logs are just files on the data volume, for this one instance only.

Run this in the lab terminal:

```bash {runsOn=lab}
sudo ls -l /var/lib/cloudalbum/logs/
sudo tail -n 3 /var/lib/cloudalbum/logs/nginx-access.json | jq -c '{ts, rid, uri, status}'
curl -s http://127.0.0.1/api/capabilities | jq '.modules.logging | {driver, status, localHealth}'
```

:::expected
The directory holds `api.log`, `worker.log` and `nginx-access.json` (plus the `.1` and `.gz` files rotated by logrotate), owned by `cloudalbum` with permissions `0640`;
logging's driver is `file` and its status `off` (the local implementation is healthy). Nginx's `rid` is the response header `X-CloudAlbum-Request-Id`, which the app logs call `requestId`.
:::

:::tip
Imagine this instance is replaced tomorrow (for example by an Auto Scaling scale-in): would these files still be there? And to find which API returned the most 5xx in the past hour, what command would you write?
:::

::checks
