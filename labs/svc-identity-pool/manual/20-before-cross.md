---
step: before-cross
---

越权测试：测试用户 A 拿着自己的前缀令牌，去写 B 的原图键、删除 B 的照片（storage=local 时另尝试列出 B 的分片）。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label before --scenario cross-prefix --upload
```

::experiment{module=identity-pool id=cross-prefix label=before}

:::expected
`attempts` 中 `write-own` 为 allowed；`write-other` 为 403 `UPLOAD_PREFIX_DENIED`，`deniedBy: application`；
`deniedByApplication` ≥ 2、`unexpected` = 0。服务端证据 `otherPhotoStatus` 是 `UPLOADING`：B 的照片没有被写入。
:::

:::why
拒绝逻辑在 `backend/src/adapters/identity-pool/none.ts`：键必须同时满足“在令牌前缀之内”与“属于令牌主人、状态为上传中的照片”两个条件。
这是应用代码的责任——写错一行，越权就成立。下一步把这件事交给 IAM。
:::

::checks
