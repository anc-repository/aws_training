---
step: session
---

Session Manager でラボ用インスタンスにログインし（デフォルトのドキュメント、`--document-name` なし）、セッションが `cloudalbum-ops` として開き、sudo が制限されていることを確認します。

```bash {runsOn=workstation}
aws ssm start-session --target {{ target.instanceId }}
```

開いたセッションで次を実行します。

```bash {runsOn=lab}
id
sudo systemctl status cloudalbum-api --no-pager | head -3
printf '{"user":"%s","secretsRc":%d}\n' "$(id -un)" "$(sudo -n cat /etc/cloudalbum/secrets.env >/dev/null 2>&1; echo $?)"
exit
```

:::expected
`id` は `cloudalbum-ops` を表示します。`systemctl status` は許可されます。`secrets.env` の読み取りは拒否されます（`secretsRc` は 0 以外）。最後の行の JSON をチェックに貼り付けてください。
:::

:::why
デフォルトの `ssm-user` も AL2023 の `ec2-user` もパスワードなしで sudo できるため、runAs を ec2-user に変えても権限は下がりません。このモジュールの hostSetup は専用ユーザー
`cloudalbum-ops` を作成し、sudoers では 1 つずつ列挙した完全なコマンドだけを許可します：`systemctl status cloudalbum-api|cloudalbum-worker --no-pager`、
`journalctl -u cloudalbum-api|cloudalbum-worker --no-pager`、`systemctl restart …`、`nginx -t`、`systemctl reload nginx`。引数の位置には `*` を使いません。
sudoers の `journalctl -u cloudalbum-*` の `*` は空白を含む任意の文字に一致するため、`--vacuum-time=1s`（root でシステムログを削除）まで許してしまいます。
注意：Run Command（`scripts/module` の配信チャネル）は常に root で実行され、runAs の影響を受けません。
:::

:::wait{typical=5 max=20}
CloudTrail の StartSession イベントには数分から十数分の遅延があります。先に次のステップのポートフォワーディングを行っても構いません。
:::

::checks
