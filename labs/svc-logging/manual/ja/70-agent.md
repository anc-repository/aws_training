---
step: agent
---

（任意）CloudWatch エージェントでの収集に切り替えます。アプリはローカルファイルに書くだけで、自分では送信しなくなります。hostSetup が `amazon-cloudwatch-agent` をインストールし、logging の設定断片
（`logs.logs_collected.files` だけを含む）を `cloudalbum-logging.json` としてレンダリングしてから `append-config` します。monitoring の設定断片も今後は同じエージェントに追加されます。

:::method{kind=script default}
```bash {runsOn=workstation}
scripts/module enable logging --param Shipper=agent --dry-run
scripts/module enable logging --param Shipper=agent
```
:::

ラボ用インスタンスのターミナルで確認します。

```bash {runsOn=lab}
systemctl status amazon-cloudwatch-agent --no-pager | head -5
sudo ls /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/
```

:::expected
エージェントは `active (running)` です。設定ディレクトリに `file_cloudalbum-logging.json` があります。logging の detail には「CloudWatch Logs（Agent 采集）」（エージェントによる収集）と表示されます。
:::

:::warning
エージェントはインスタンスプロファイルの認証情報だけを使い、`secrets.env` のキーは読みません。`IAM_CREDENTIALS=keys` のときは `Shipper=agent` が拒否されます。
:::

::checks
