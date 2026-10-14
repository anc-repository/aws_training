---
step: rates
---

（选做）本项目不提供任何默认单价。如果你想让本地清单显示估算金额，自己到官方定价页查到单价，抄录到实验机的
`/etc/cloudalbum/cost-rates.yaml`，**必须**注明出处（`source`，官方定价页 URL）与抄录日期（`retrievedAt`）：

```bash {runsOn=lab}
sudo tee /etc/cloudalbum/cost-rates.yaml > /dev/null <<'YAML'
currency: USD
region: {{ session.region }}
entries:
  - resource: "EC2 实例（按需）"          # 必须与 registry billing.resource 逐字一致
    unit: hour
    rate: <你从官方定价页抄录的单价>
    source: https://aws.amazon.com/ec2/pricing/on-demand/
    retrievedAt: <抄录日期，例如 2026-10-14>
YAML
sudo chown root:cloudalbum /etc/cloudalbum/cost-rates.yaml && sudo chmod 0640 /etc/cloudalbum/cost-rates.yaml
curl -s http://127.0.0.1/api/capabilities | jq -r '.modules.cost.detail'
```

再故意删掉某个条目的 `source` 看看会怎样。

:::code-ref{path=backend/src/adapters/cost/estimate.ts}
`loadCostRates()` 只接受注明 https 出处（`source`）与抄录日期（`retrievedAt`）、`resource` 与 registry `billing.resource` 逐字一致的条目；
`estimateCost()` 只对按小时计费的条目计算“单价 × 本月累计小时 × 数量”，其余条目写“本机无法估算”。
:::

:::expected
填好后 detail 出现“估算 USD …（1 项单价由学员抄录，注明了出处与日期；不是账单）”；删掉 `source` 的条目不参与估算，
detail 提示“未注明出处”，并出现 CFG-010 警告。
:::

:::warning
这只是估算：只覆盖按小时计费的部分，不含数据传输、请求、税费与抵扣额度。真实金额以 Budgets 与 Cost Explorer 为准。
:::

::checks
