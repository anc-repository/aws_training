---
step: fail-open
---

（任意）キャッシュの故障です。ランナーは 30 秒目に `sg-cache` にあるラボ用インスタンスのセキュリティグループからの 6379 インバウンドルールを一時的に取り消し、80 秒目に戻します。その間もタイムラインを読み続けます。
障害スクリプトはワークベンチであなたの権限で実行され、2 つのセキュリティグループ ID が必要です。

```bash {runsOn=workstation}
export CACHE_SG_ID=$(aws elasticache describe-cache-clusters --cache-cluster-id "{{ var.replicationGroupId }}-001" --query "CacheClusters[0].SecurityGroups[0].SecurityGroupId" --output text)
export APP_SG_ID={{ target.sgId }}
npm run exp -- cache --label after --scenario fail-open --fault-via local --upload
```

::experiment{module=cache id=fail-open label=after}

:::warning
ランナーが途中で中断された場合は、すぐにルールを元に戻してください：`bash experiments/cache/faults/revoke-sg.sh restore`（同じターミナルなら環境変数が残っています）。
終了時のチェックで 6379 のルールが残っていることを確認します。
:::

:::expected
障害中のエラー数は 0 で、経路ヘッダーに `cache=redis@elasticache:error-bypass` が現れ、レイテンシーはキャッシュなしの水準に戻ります。cache モジュールは一時的に degraded になり、復旧後は正常に戻ります。
:::

::checks
