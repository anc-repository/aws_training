---
step: failures
---

失败路径：上传损坏的 JPEG（合法的文件头 + 随机字节）。这是永久错误——重试多少次都不会成功，所以函数直接回写 FAILED，不抛异常、不重试。

```bash {runsOn=workstation}
npm run exp -- image-processing --label after --scenario failures --param count=3 --upload
```

::experiment{module=image-processing id=failures label=after}

:::expected
3 张照片都很快变成 FAILED（`scenario.notFailed` 为 0）；失败队列仍为空。
:::

:::why
**永久错误与暂时错误要分开处理**：暂时错误（下游超时、限流）由函数抛出异常，Lambda 异步重试 2 次（间隔约 1、2 分钟），
用尽后送往失败目标，再由应用对账；永久错误重试只会浪费调用费，应由函数自己判定并直接回写结果。
:::

:::tip
选读：模块的函数支持环境变量 `FAULT_RATE`（0～1）按比例抛出暂时错误。手工演示要用 `aws lambda update-function-configuration`
改函数的环境变量（必须带上全部原有变量），本卡不要求操作。若你做了演示，结束前重新执行
`scripts/module enable image-processing --param ResultChannel=queue` 还原配置；本步骤的检查会持续确认 `FAULT_RATE` 不存在。
:::

::checks
