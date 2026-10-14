---
step: orient
---

まず出発点を確認します。メトリクスもアラームもラボ用インスタンスの内部にあります。

1. 右側の「アプリのプレビュー」で `/lab/m/monitoring` を開きます。各グラフには「数据来自 i-xxxx · 10 秒样本」（データの出所 i-xxxx・10 秒サンプル）と書かれ、アラームパネルの届け先は「本地（实例宕机即失效）」（ローカル。インスタンスが停止すると無効）です。
2. ラボ用インスタンスのターミナルで、ローカル評価器のルールと状態を確認します。

```bash {runsOn=lab}
sudo cat /etc/cloudalbum/alerts.yaml 2>/dev/null || echo "（ファイルなし：組み込みの既定ルールを使用）"
curl -s http://127.0.0.1/api/capabilities | jq '.modules.monitoring | {driver, status, localHealth, detail}'
systemctl is-active amazon-cloudwatch-agent || true
```

:::expected
`driver` は `local`、`status` は `off`、`localHealth` は `ok` で、detail には「本地评估器 6 条规则」（ローカル評価器のルール 6 件）があります。エージェントは動いていません（L0 ではインストールしません）。
:::

:::tip
`alerts.yaml` はデータボリューム上にあり（データボリュームとともに移行されます）、実行時のホットキーではありません。変更すると、worker の次の評価から新しいルールが読み込まれます。
:::

::checks
