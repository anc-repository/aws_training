---
step: ebs-growth
---

（任意）データボリュームを一時的に「満杯」にします。アップロードは成功します（バイトは S3 にあるため）が、コメントの書き込みは失敗します（SQLite はまだこのディスク上にあるため）。スクリプトの終了時にダミーファイルは自動で解放されます。

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario ebs-growth --upload
```

::experiment{module=storage id=ebs-growth label=after}

:::danger
スクリプトが途中で中断された場合は、ラボ用インスタンスのターミナルで次のコマンドを実行してダミーファイルを解放してください。そうしないと、環境を保持したときにデータボリュームが満杯のままになります。

```bash {runsOn=lab}
sudo bash experiments/storage/faults/balloon.sh release
```
:::

::checks
