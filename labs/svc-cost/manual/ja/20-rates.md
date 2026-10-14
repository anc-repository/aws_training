---
step: rates
---

（任意）このプロジェクトは既定の単価を一切提供しません。ローカルの一覧に見積もり金額を表示したい場合は、公式の料金ページで単価を調べ、ラボ用インスタンスの
`/etc/cloudalbum/cost-rates.yaml` に書き写します。出典（`source`、公式料金ページの URL）と書き写した日付（`retrievedAt`）は**必ず**明記してください。

```bash {runsOn=lab}
sudo tee /etc/cloudalbum/cost-rates.yaml > /dev/null <<'YAML'
currency: USD
region: {{ session.region }}
entries:
  - resource: "EC2 实例（按需）"          # registry の billing.resource と一字一句一致させる
    unit: hour
    rate: <公式料金ページから書き写した単価>
    source: https://aws.amazon.com/ec2/pricing/on-demand/
    retrievedAt: <書き写した日付。例：2026-10-14>
YAML
sudo chown root:cloudalbum /etc/cloudalbum/cost-rates.yaml && sudo chmod 0640 /etc/cloudalbum/cost-rates.yaml
curl -s http://127.0.0.1/api/capabilities | jq -r '.modules.cost.detail'
```

次に、ある項目の `source` をわざと削除してどうなるか見てみましょう。

:::code-ref{path=backend/src/adapters/cost/estimate.ts}
`loadCostRates()` が受け付けるのは、https の出典（`source`）と書き写した日付（`retrievedAt`）を明記し、`resource` が registry の `billing.resource` と一字一句一致する項目だけです。
`estimateCost()` は時間課金の項目についてだけ「単価 × 今月の累計時間 × 数量」を計算し、それ以外の項目には「本机无法估算」（このホストでは見積もれない）と書きます。
:::

:::expected
入力すると detail に「估算 USD …（1 项单价由学员抄录，注明了出处与日期；不是账单）」（見積もり USD …（単価 1 件は受講者が書き写したもので、出典と日付を明記済み。請求書ではありません））が表示されます。`source` を削除した項目は見積もりに使われず、
detail に「未注明出处」（出典なし）と表示され、CFG-010 の警告が出ます。
:::

:::warning
これはあくまで見積もりです。時間課金の部分しか含まず、データ転送、リクエスト、税金、クレジットは含みません。実際の金額は Budgets と Cost Explorer で確認してください。
:::

::checks
