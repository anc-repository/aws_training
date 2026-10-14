---
step: cloudtrail
---

CloudTrail のイベント履歴でアプリの呼び出しを探します。インスタンスロールのセッションのセッション名はインスタンス ID です。

```bash {runsOn=workstation}
aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue={{ target.instanceId }} --max-results 5 --query "Events[].CloudTrailEvent" --output text | jq -r "{eventName, type: .userIdentity.type, arn: .userIdentity.arn, keyPrefix: (.userIdentity.accessKeyId // \"\" | .[0:4])}"
```

:::method{kind=console}
::console-link[CloudTrail のイベント履歴を開く]{link=cloudtrail.events}

「ユーザー名」を `{{ target.instanceId }}` で絞り込み、任意のイベントを開いて `userIdentity` を見ます。
:::

:::wait{typical=10 max=20}
イベントがイベント履歴に現れるまで、通常は数分から十数分かかります。見つからないときは、プレビューでいくつか操作をしてから、しばらくして確認してください。
:::

:::expected
`userIdentity.type` は `AssumedRole`、`arn` は `assumed-role/CloudAlbumAppRole/{{ target.instanceId }}`、`accessKeyId` は `ASIA` で始まります。
長期のアクセスキーのイベントなら `IAMUser` と `AKIA` になります。
:::

::checks
