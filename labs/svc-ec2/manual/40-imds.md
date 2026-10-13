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
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id; echo
```

:::expected
不带令牌的请求返回 `401`；带令牌的请求返回实例 ID。
:::

:::why
IMDSv2 有两道关：取令牌必须用 `PUT` 并带特定请求头，典型的 SSRF 只能让服务器发 GET；令牌响应的跳数限制（这里是 1）让它离不开实例。
实例元数据服务是实例本地的链路地址，安全组与 NACL 都控制不了它。
:::

::checks
