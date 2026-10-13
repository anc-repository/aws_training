---
step: enable
---

接入 Lambda：`scripts/module` 把 `lambdas/image-thumbnail` 打包（esbuild + linux-arm64 的 sharp）上传到工具链桶，
部署函数、日志组、异步调用配置、EventBridge 规则、失败队列与结果队列，再先重启 worker、后重启 api，最后跑端到端探针。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable image-processing --param ResultChannel=queue --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable image-processing --param ResultChannel=queue
```
:::

:::wait{typical=4 max=15}
打包、上传、部署与端到端探针。完成后在应用预览里上传 3 张照片，让平台看到真实的 Lambda 处理路径。
:::

:::expected
image-processing 的状态为“正常”；上传请求的路径头出现 `image-processing=lambda:async`；照片详情的徽章显示“缩略图由 AWS Lambda 生成”。
:::

:::why
**为什么回写选结果队列而不是 HMAC 回调？** 回调需要 Lambda 从公网访问实验机（DEP-021 会把模块标为 degraded，且依赖对公网开放入站端口）；
结果队列由 EC2 主动长轮询，不需要任何入站流量，实验机停机时结果也留在队列里。HMAC 回调的设计见模块文档（选读）。
:::

::checks
