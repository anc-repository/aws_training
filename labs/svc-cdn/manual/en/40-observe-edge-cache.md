---
step: observe-edge-cache
---

`/api/public/now` returns `Cache-Control: public, s-maxage=10, max-age=0`, and the cache key of the `/api/public/*` behavior includes every query parameter.
So if you send two requests with a **new** query parameter, the first one always goes back to the origin (Miss), and the second one within 10 seconds should come from the edge (Hit).

Try it yourself first (workbench terminal):

```bash {runsOn=workstation}
N=$(date +%s%N)
for i in 1 2; do
  curl -s -o /dev/null -D - "https://{{ var.cdnDomain }}/api/public/now?atlprobe=$N" \
    | grep -iE '^(x-cache|age|x-amz-cf-pop|x-cloudalbum-path):'
  sleep 1
done
echo "nonce: $N"
```

:::expected
```text
x-cache: Miss from cloudfront
x-cloudalbum-path: entry=cloudfront>nginx;inst={{ target.instanceId }};az={{ target.az }}
x-cache: Hit from cloudfront
age: 1
x-cloudalbum-path: entry=cloudfront>nginx;inst={{ target.instanceId }};az={{ target.az }}
```
The second `x-cloudalbum-path` is exactly the same as the first — it is the cached copy of the response headers.
Occasionally both requests are a Miss: each `curl` opens a new connection, which may land on a different cache host in the same edge location. Just run it again; the platform's check reuses one connection for both requests.
:::

Then look at the origin log in the **lab instance terminal**: the same `atlprobe` appears only **once**, on port 8080. Replace `<nonce>` in the command below with the value printed in the previous step (the two terminals do not share variables):

```bash {runsOn=lab vars=false}
sudo tail -n 200 /var/lib/cloudalbum/logs/nginx-access.json | grep "atlprobe=<nonce>" | jq -c '{ts, port, status, args}'
```

:::why
**Why doesn't the platform simply trust the headers you see?** `X-Cache` and `X-Amz-Cf-Id` are just text; one `add_header` line in the origin's Nginx can produce them.
So when you click Check, the platform sends these two requests itself, and:
1. only requests the domain of the distribution created in this lab, which it looks up through the CloudFront API;
2. verifies that the peer IP belongs to CloudFront's published address ranges and that the certificate is `*.cloudfront.net`;
3. counts how many times the nonce appears in the origin log — **two requests, but only one reached the origin** proves that the second one really was an edge hit.

Through CloudFront, the platform also requests CloudAlbum's probe endpoint `/api/lab/probe/now` (`Cache-Control: private, no-store`) twice to confirm that authenticated APIs miss the cache both times — if a personalized API were cached, user A's data would be returned to user B.
:::

:::saa{domain=performance confusable="浏览器缓存 vs 边缘缓存"}
`max-age` controls the browser cache and `s-maxage` controls shared caches (CloudFront). When a cache policy's minimum TTL is greater than 0, the origin's `no-cache`/`private` is ignored.
:::

::check{id=edge-cache-observed}
::check{id=api-not-cached}
