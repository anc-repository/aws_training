---
step: orient
---

アプリのプレビューでアルバムを見てから、ラボ用インスタンスのターミナルでデータベースの場所を確認します。

```bash {runsOn=lab}
curl -s -o /dev/null -D - "http://127.0.0.1/api/feed?limit=24" | grep -iE "^(x-cloudalbum-path|server-timing):"
curl -s http://127.0.0.1/api/capabilities | jq ".modules.database | {driver, status, detail}"
```

:::expected
経路ヘッダーの database セグメントは `sqlite` です。管理画面には「SQLite（EBS 文件）」（SQLite（EBS ファイル））と表示されます。
:::

:::why
**考えてみましょう**：この EC2 を停止したら、データベースはどうなるでしょうか？ SQLite は EC2 と一蓮托生です。このステップでは実際には停止しません（停止するとプラットフォームの管理チャネルが切れるためです）。
ステップ 7 のフェイルオーバーの結果と見比べるために取っておいてください。
:::

::checks
