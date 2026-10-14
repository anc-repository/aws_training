---
section: wrap-up
---

## 你做到了什么

- 把 F14 的授权从“应用代码逐片校验前缀令牌”换成“IAM 策略变量在 S3 端执行”：浏览器持有只能写自己前缀的 STS 临时凭证，分片直传暂存桶。
- 用越权实验看到了两种拒绝：应用返回的 403 `UPLOAD_PREFIX_DENIED` 与 S3 返回的 `AccessDenied`。
- 量化了对后端的请求数：前缀令牌随分片数线性增长，临时凭证只与文件数有关。
- 读懂了已认证角色的信任策略（aud、amr）与权限策略（`${cognito-identity.amazonaws.com:sub}`），看到了服务端 CopyObject 导入的代价。

## 考点回顾

- User Pool 与 Identity Pool 的分工；Web 身份联合与 `AssumeRoleWithWebIdentity`；开发者认证身份（auth=local 时用 `GetOpenIdTokenForDeveloperIdentity`）。
- 策略变量 `${cognito-identity.amazonaws.com:sub}` 是 Identity ID，不是 User Pool 的 sub；信任策略的 `aud`、`amr` 条件；访客身份的风险。
- 预签名 URL、应用自签令牌与临时凭证的取舍：授权位置、请求次数、撤销方式、服务端控制力。
- S3 CORS 必须暴露 `ETag`；分片上传与生命周期规则清理未完成的分片；SSE-KMS 下分片上传还需要 `kms:Decrypt`。
