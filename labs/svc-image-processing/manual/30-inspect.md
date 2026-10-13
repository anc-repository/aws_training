---
step: inspect
---

看懂“谁触发了函数、函数能做什么、失败去哪里”。这些配置由模块栈管理，**只看不改**。

:::method{kind=console default}
::console-link[打开缩略图函数]{link=lambda.function functionName="{{ var.functionName }}"}

1. “函数概览”：触发器是 EventBridge 规则 `{{ var.ruleName }}`；“目标”是失败时的 SQS 队列。
2. “配置 → 权限”：执行角色只允许读原图桶的 `raw/*`、只允许写展示桶的 `variants/*`，并能向失败队列与结果队列发送消息。
3. “配置 → 异步调用”：重试 2 次、最大事件年龄 1 小时、失败目标为 `image-processing-failures`。
4. 打开 EventBridge 规则：事件模式只匹配原图桶 `raw/` 前缀的 `Object Created`；目标同时配置了重试策略与死信队列。
5. “监控 → 查看 CloudWatch Logs”：每次调用末尾的 `REPORT` 行包含 `Duration`、`Billed Duration`、`Max Memory Used`，冷启动时还有 `Init Duration`。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws events describe-rule --name "{{ var.ruleName }}" --query EventPattern --output text
aws events list-targets-by-rule --rule "{{ var.ruleName }}"
aws lambda get-function-event-invoke-config --function-name "{{ var.functionName }}"
aws logs tail "{{ var.logGroup }}" --since 30m --filter-pattern REPORT
```
:::

:::why
**两层失败，一个去处**：规则目标上的死信队列处理“EventBridge 投递不到 Lambda”（例如权限被删）；函数的失败目标处理
“Lambda 执行失败且重试用尽”。两者都汇入同一个失败队列，由应用的对账任务读取后重投或标记 FAILED。
:::

:::saa{domain=cost confusable="S3 事件通知 vs EventBridge"}
S3 事件通知的同一事件类型与重叠前缀只能有一个目标；统一投递到 EventBridge 后，多个消费者在各自的栈里建规则（编舞），互不冲突。
输入与输出分开（原图桶 `raw/` → 展示桶 `variants/`）是避免递归调用的根本办法。
:::

::checks
