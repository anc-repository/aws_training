---
step: inspect
---

Work out who triggers the function, what the function can do, and where failures go. These settings are managed by the module stack, so **look but do not change**.

:::method{kind=console default}
::console-link[Open the thumbnail function]{link=lambda.function functionName="{{ var.functionName }}"}

1. "Function overview": the trigger is the EventBridge rule `{{ var.ruleName }}`; the "Destination" is the SQS queue for failures.
2. "Configuration → Permissions": the execution role may only read `raw/*` in the original-image bucket and only write `variants/*` in the display bucket, and can send messages to the failure and result queues.
3. "Configuration → Asynchronous invocation": 2 retries, a maximum event age of 1 hour, and `image-processing-failures` as the on-failure destination.
4. Open the EventBridge rule: the event pattern only matches `Object Created` under the `raw/` prefix of the original-image bucket; the target has both a retry policy and a dead-letter queue.
5. "Monitor → View CloudWatch logs": the `REPORT` line at the end of each invocation contains `Duration`, `Billed Duration` and `Max Memory Used`, plus `Init Duration` on a cold start.
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
**Two layers of failure, one destination**: the dead-letter queue on the rule target handles "EventBridge cannot deliver to Lambda" (for example because a permission was removed); the function's on-failure destination handles
"Lambda execution failed and retries are used up". Both land in the same failure queue, which the app's reconciliation job reads to redeliver or mark FAILED.
:::

:::saa{domain=cost confusable="S3 事件通知 vs EventBridge"}
S3 event notifications allow only one destination for the same event type and overlapping prefixes; delivering everything to EventBridge lets several consumers create rules in their own stacks (choreography) without clashing.
Separating input and output (original-image bucket `raw/` → display bucket `variants/`) is the fundamental way to avoid recursive invocations.
:::

::checks
