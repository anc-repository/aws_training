---
step: imds
---

模拟一个只能让服务器代发 GET 请求的 SSRF：不带会话令牌直接读元数据。

```bash {runsOn=lab}
curl -s -o /dev/null -w "without token: %{http_code}\n" http://169.254.169.254/latest/meta-data/instance-id
```

正规流程先用 PUT 取会话令牌，再带令牌读取：

```bash {runsOn=lab}
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -o /dev/null -w "with token: %{http_code}\n" -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id
```

:::expected
不带令牌的请求返回 `401`；带令牌的请求返回 `200`。
:::

:::why
IMDSv2 有两道关：取令牌必须用 `PUT` 并带 `X-aws-ec2-metadata-token-ttl-seconds` 请求头，只能代发 GET 的 SSRF 做不到；
令牌响应的 IP 跳数限制（默认 1，容器场景常设为 2）让它离不开实例。
:::

::checks
