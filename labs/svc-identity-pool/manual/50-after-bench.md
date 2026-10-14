---
step: after-bench
---

同一测试用户、同样的 10 个文件，这次用 STS 临时凭证直传暂存桶。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario upload-bench --upload
npm run exp:report -- identity-pool --experiment upload-bench
```

::experiment{module=identity-pool id=upload-bench label=after}

:::expected
`mode=sts`，`backendRequestsPerFile` 约为 2（建档与 complete，外加整批只换一次凭证），与分片数无关；`s3RequestsPerFile` = 分片数 + 2
（CreateMultipartUpload、UploadPart × n、CompleteMultipartUpload）。服务端证据：每张照片在服务端已是 `PROCESSING` / `READY`，
抽查的暂存对象在 complete 之后已经被删除（服务端 CopyObject 之后 DeleteObject）。
:::

:::tip
EC2 入站流量在两边都只有元数据：本卡起始状态的 storage 已经是 S3，before 的分片也直传 S3，只是每一片都先问 EC2。
想看“字节经过 EC2”的基线，在 storage=local 的 L0 上单独跑 `--label before --param mode=token`（选读）。
:::

::checks
