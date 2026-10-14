---
step: baseline
---

before を記録します。ワークベンチからラボ用インスタンスの**プライベートアドレス**の 22 番と 443 番ポートを調べ（それぞれ 5 回、タイムアウト 3 秒）、サーバー側の証拠としてセキュリティグループの 22 番ポートのルールを読み取ります。

```bash {runsOn=workstation}
npm run exp -- shell-access --label before --scenario probe-port --param target=private-ip --upload
```

::experiment{module=shell-access id=probe-port label=before}

次に SSH で一度ログインし、SSH がどんな監査情報を残すかを確認します。

```bash {runsOn=workstation}
ssh lab 'id; sudo journalctl -u sshd -n 5 --no-pager -o cat'
```

:::expected
レポートの `port22.result` は `open`、`sgRules22` は 1 です。journal には `Accepted publickey for ec2-user from <ワークベンチの IP> … SHA256:…` しかありません。
「どの鍵がどの IP からログインしたか」はわかっても、ログイン後に何をしたかはわかりません。
:::

:::tip
プラットフォームモードでは 22 はワークベンチのプライベートアドレスにだけ開いているため、パブリックアドレスから調べると before の時点ですでにタイムアウトになります。そこで `--param target=private-ip` を使います
（ランナーは `aws ec2 describe-instances` でラボ用インスタンスのプライベートアドレスを調べます）。
:::

::checks
