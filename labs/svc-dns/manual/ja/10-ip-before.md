---
step: ip-before
---

まず Route 53 がない状態で「IP を 1 回変えて」みます。スクリプトがラボ用インスタンスに一時的な Elastic IP を関連付けると、古い IP のリンクはすぐに使えなくなり、自然には復旧しないことがわかります。

:::why
L0 では Elastic IP の関連付けが必須です。そうしないと、インスタンスを停止して再起動したときにパブリック IP が変わってしまいます。しかし Elastic IP も変わることがあります（インスタンスの交換、ネットワークの移行、誤った解放など）。リンクに IP を直接書くと、
「アドレス」と「名前」が結び付いてしまいます。
:::

訓練スクリプトはワークベンチであなたの権限で AWS CLI を呼び出し（`--fault-via local`）、終了時には必ず元の EIP を関連付け直して一時的な EIP を解放します。

```bash {runsOn=workstation}
npm run exp -- dns --label before --scenario ip-change-drill --fault-via local --param env={{ session.env }} --upload
```

::experiment{module=dns id=ip-change-drill label=before}

:::expected
約 5 分で終わり、最後に `runId` が表示されます。結果の `oldLinkFailures` は 0 より大きく（訓練中、古い IP のリンクはずっと失敗します）、`swapAt` に値があります。
`drill.newIp` は一時的なアドレスです。訓練が終わると、ラボ用インスタンスには元の `{{ target.publicIp }}` が戻ります。
:::

:::warning
訓練中は、プラットフォームが記録しているラボ用インスタンスの IP が一時的に無効になります。**「チェック」を押さないでください**。ワークベンチのターミナルも閉じないでください。途中で中断された場合は、次を実行します。

```bash {runsOn=workstation}
bash experiments/dns/faults/reassociate-eip.sh restore --env {{ session.env }}
```
:::

::checks
