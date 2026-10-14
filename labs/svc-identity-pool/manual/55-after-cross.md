---
step: after-cross
---

再做一次越权测试：A、B 各自换取凭证，A 用自己的 ASIA 凭证写 B 的前缀、列出整个桶、删除 B 的对象。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario cross-prefix --upload
```

::experiment{module=identity-pool id=cross-prefix label=after}

:::expected
`write-own`、`list-own` 为 allowed；`write-other`、`list-root`、`delete-other` 都是 S3 返回的 403 `AccessDenied`，`deniedBy: s3`；
`unexpected` = 0。服务端证据：A 自己的对象存在，写到 B 前缀的对象不存在，B 的对象没有被删除。
:::

:::why
这次拒绝发生在 S3：IAM 按请求者的身份把 `${cognito-identity.amazonaws.com:sub}` 替换成 A 的 identityId，再与资源 ARN 比较。
应用代码完全不参与——这也意味着应用看不到这些请求（直传 S3 的请求不经过 Nginx 和 WAF）；需要审计时要开启 CloudTrail 的 S3 数据事件（收费）。
:::

::checks
