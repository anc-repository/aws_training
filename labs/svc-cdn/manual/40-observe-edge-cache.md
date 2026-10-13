---
step: observe-edge-cache
---

`/api/public/now` 返回 `Cache-Control: public, s-maxage=10, max-age=0`，`/api/public/*` 行为的缓存键包含全部查询参数。
所以：带一个**新的**查询参数请求两次，第一次一定回源（Miss），10 秒内的第二次应当由边缘返回（Hit）。

先自己看一遍（工作台终端）：

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
第二次的 `x-cloudalbum-path` 与第一次完全相同——它是被缓存下来的那份响应头。
偶尔两次都是 Miss：两次 `curl` 各开一条新连接，可能落到同一站点里的不同缓存主机上。再运行一次即可；平台检测会让两次请求复用同一条连接。
:::

再到**实验机终端**看源站日志：同一个 `atlprobe` 只出现**一次**，端口是 8080。把下面命令中的 `<nonce>` 换成上一步打印的值（两个终端不共享变量）：

```bash {runsOn=lab vars=false}
sudo tail -n 200 /var/lib/cloudalbum/logs/nginx-access.json | grep "atlprobe=<nonce>" | jq -c '{ts, port, status, args}'
```

:::why
**为什么平台不直接相信你看到的这些头？** `X-Cache`、`X-Amz-Cf-Id` 只是文本，源站 Nginx 一行 `add_header` 就能写出来。
所以点“检测”时，平台会自己发这两次请求，并且：
1. 只请求它从 CloudFront API 查到的、本次实验创建的分配域名；
2. 核对对端 IP 属于 CloudFront 公布的地址段、证书是 `*.cloudfront.net`；
3. 去源站日志里数这个 nonce 出现了几次——**两次请求、源站只收到一次**，才证明第二次真的是边缘命中。

平台还会经 CloudFront 请求两次 CloudAlbum 的探测端点 `/api/lab/probe/now`（`Cache-Control: private, no-store`），确认认证类接口两次都不命中缓存——个性化 API 被缓存，就会把 A 用户的数据返回给 B 用户。
:::

:::saa{domain=performance confusable="浏览器缓存 vs 边缘缓存"}
`max-age` 控制浏览器缓存，`s-maxage` 控制共享缓存（CloudFront）。缓存策略的最小 TTL 大于 0 时，会无视源站的 `no-cache`/`private`。
:::

::check{id=edge-cache-observed}
::check{id=api-not-cached}
