---
step: throttle
---

紧急刹车：把函数的预留并发设为 0（等于暂停函数），在预览中上传 2～3 张照片，观察 2 分钟后再删除预留并发。

```bash {runsOn=workstation}
aws lambda put-function-concurrency --function-name "{{ var.functionName }}" --reserved-concurrent-executions 0
aws lambda get-function-concurrency --function-name "{{ var.functionName }}"
```

在应用预览里上传 2～3 张照片，然后打开函数的“监控”页，看 `Throttles` 与 `AsyncEventsDropped`（指标约有 1～2 分钟延迟）。

```bash {runsOn=workstation}
aws lambda delete-function-concurrency --function-name "{{ var.functionName }}"
aws lambda get-function-concurrency --function-name "{{ var.functionName }}"
```

:::warning
一定要执行最后的 `delete-function-concurrency`。预留并发留在 0，之后所有照片的缩略图都不会生成；本步骤与结束检查都会确认它已删除。
:::

:::expected
暂停期间 `Throttles` 或 `AsyncEventsDropped` 出现非零值。按 AWS 文档，预留并发为 0 时异步事件不会排队等到恢复，而是被丢弃并送往失败目标；
这些照片随后由应用的对账任务处理（重投或标记 FAILED，以实测为准）。删除预留并发后，新上传的照片恢复正常。
:::

:::saa{domain=performance confusable="预留并发 vs 预置并发"}
预留并发从账号的并发配额中划出一部分，既是保底也是上限；设为 0 就是“刹车”。预置并发预先初始化执行环境、消除冷启动，按时长计费。
新账号的并发配额可能很低，大量预留会挤占其他函数。
:::

::checks
