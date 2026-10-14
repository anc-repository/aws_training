---
step: enable
---

启用 Identity Pool。模块会创建：身份池（不允许访客身份，身份提供方是 auth 栈的 User Pool 客户端，经 registry 的 injects 传入）、
已认证角色 `cloudalbum-<env>-identity-pool-uploader`（模块文档里的 “CloudAlbumUploaderRole”）、暂存桶
`cloudalbum-<env>-upload-staging-<账号>`（CORS 暴露 ETag、`private/` 下 1 天过期、未完成的分片上传 1 天后中止、不配任何事件通知）。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable identity-pool --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable identity-pool
```
:::

:::wait{typical=3 max=15}
部署身份池、角色与暂存桶通常一两分钟，随后写入 `identity-pool.env` 并重启 api。重启后的最初一两分钟，第一次探针可能较慢，
状态短暂显示为黄色属于正常现象。
:::

完成后，在应用预览里一次选两张照片上传，看 DevTools：

- `GET /api/uploads/credentials` 返回 `accessKeyId`（`ASIA…`）、`expiration`、`identityId` 与 `prefix=private/<identityId>/`；
- 分片请求直达 `…upload-staging-….s3.ap-northeast-1.amazonaws.com`，中间没有发往 EC2 的请求；
- `POST /api/photos/<id>/complete` 的响应头 `X-CloudAlbum-Path` 含 `identity-pool=cognito:sts` 与 `storage=s3:import`。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules["identity-pool"] | {driver, status, detail}'
```

:::expected
identity-pool 为“正常（含预期警告 DEP-030）”或“正常”，driver 为 `cognito`；身份池不允许访客身份，已认证角色是 Uploader 角色。
:::

:::saa{domain=secure confusable="User Pool vs Identity Pool"}
User Pool 签发的 JWT 不能直接调用 AWS API；Identity Pool 用它换取 IAM 角色的临时凭证。凭证在有效期内（约一小时，以官方文档为准）
可以发任意多次请求，范围由角色策略限定——这和“每个请求一个”的预签名 URL 不同。
:::

::checks
