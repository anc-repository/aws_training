---
step: cloudtrail
---

Find the app's calls in the CloudTrail event history. The session name of an instance role session is the instance ID:

```bash {runsOn=workstation}
aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue={{ target.instanceId }} --max-results 5 --query "Events[].CloudTrailEvent" --output text | jq -r "{eventName, type: .userIdentity.type, arn: .userIdentity.arn, keyPrefix: (.userIdentity.accessKeyId // \"\" | .[0:4])}"
```

:::method{kind=console}
::console-link[Open the CloudTrail event history]{link=cloudtrail.events}

Filter on "User name" = `{{ target.instanceId }}`, open any event and look at `userIdentity`.
:::

:::wait{typical=10 max=20}
Events usually take a few minutes to over ten minutes to show up in the event history. If you cannot find any, do a few things in the preview and check again later.
:::

:::expected
`userIdentity.type` is `AssumedRole`, `arn` is `assumed-role/CloudAlbumAppRole/{{ target.instanceId }}`, and `accessKeyId` starts with `ASIA`.
Events from a long-term access key would show `IAMUser` and `AKIA` instead.
:::

::checks
