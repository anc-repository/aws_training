---
step: cloudtrail
---

在 CloudTrail 事件历史中找应用的调用。实例角色会话的会话名就是实例 ID：

```bash {runsOn=workstation}
aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue={{ target.instanceId }} --max-results 5 --query "Events[].CloudTrailEvent" --output text | jq -r "{eventName, type: .userIdentity.type, arn: .userIdentity.arn, keyPrefix: (.userIdentity.accessKeyId // \"\" | .[0:4])}"
```

:::method{kind=console}
::console-link[打开 CloudTrail 事件历史]{link=cloudtrail.events}

筛选“用户名”为 `{{ target.instanceId }}`，打开任意一条事件，查看 `userIdentity`。
:::

:::wait{typical=10 max=20}
事件出现在事件历史中通常有几分钟到十几分钟的延迟。查不到时先在预览中做几次操作，稍后再查。
:::

:::expected
`userIdentity.type` 为 `AssumedRole`，`arn` 是 `assumed-role/CloudAlbumAppRole/{{ target.instanceId }}`，`accessKeyId` 以 `ASIA` 开头。
长期访问密钥的事件则是 `IAMUser` 与 `AKIA`。
:::

::checks
