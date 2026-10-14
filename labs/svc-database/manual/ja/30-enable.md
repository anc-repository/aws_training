---
step: enable
---

RDS を組み込みます。モジュールはデフォルト VPC に DB サブネットグループ、`sg-db`（5432 はラボ用インスタンスのセキュリティグループだけを許可）、パラメーターグループ（`rds.force_ssl=1`、スロークエリログ）、
`db.t4g.micro` のマルチ AZ インスタンス（PostgreSQL 16、gp3 20 GiB、暗号化、自動バックアップを 7 日間保持）を作成します。次に RDS の CA バンドルをラボ用インスタンスにダウンロードし、
読み取り専用期間中に（worker を止めて）SQLite のデータを移行し、最後に再起動します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true
```
:::

:::wait{typical=20 max=45}
マルチ AZ インスタンスの作成には通常 20 分ほどかかります（プライマリと、別の AZ にあるスタンバイを同時に作成します）。移行中もアプリは閲覧できますが、書き込みはできません。
:::

:::expected
database の状態は「正常」で、detail にマルチ AZ とプライマリのある AZ が表示されます。経路ヘッダーに `database=postgres@rds` が現れ、管理画面には「PostgreSQL（Amazon RDS）」と表示されます。
:::

:::warning
コンソールでインスタンスの削除保護を有効にしないでください。プラットフォームの回収が失敗し、セッションが CLEANUP_FAILED になります。
:::

::checks
