---
step: rates
---

(Optional) This project provides no default prices at all. If you want the local list to show an estimated amount, look up the unit prices on the official pricing pages yourself and copy them into
`/etc/cloudalbum/cost-rates.yaml` on the lab instance. You **must** state the source (`source`, the official pricing page URL) and the date you copied them (`retrievedAt`):

```bash {runsOn=lab}
sudo tee /etc/cloudalbum/cost-rates.yaml > /dev/null <<'YAML'
currency: USD
region: {{ session.region }}
entries:
  - resource: "EC2 实例（按需）"          # must match registry billing.resource exactly
    unit: hour
    rate: <the unit price you copied from the official pricing page>
    source: https://aws.amazon.com/ec2/pricing/on-demand/
    retrievedAt: <the date you copied it, e.g. 2026-10-14>
YAML
sudo chown root:cloudalbum /etc/cloudalbum/cost-rates.yaml && sudo chmod 0640 /etc/cloudalbum/cost-rates.yaml
curl -s http://127.0.0.1/api/capabilities | jq -r '.modules.cost.detail'
```

Then deliberately delete the `source` of one entry and see what happens.

:::code-ref{path=backend/src/adapters/cost/estimate.ts}
`loadCostRates()` only accepts entries that state an https source (`source`) and a copy date (`retrievedAt`), and whose `resource` matches the registry's `billing.resource` exactly;
`estimateCost()` only computes "unit price × hours so far this month × quantity" for hourly entries, and writes "本机无法估算" (cannot be estimated on this host) for the rest.
:::

:::expected
Once filled in, detail shows "估算 USD …（1 项单价由学员抄录，注明了出处与日期；不是账单）" (estimate USD … (1 unit price copied by the learner with a source and date; not a bill)); an entry without `source` is left out of the estimate,
detail says "未注明出处" (no source stated), and a CFG-010 warning appears.
:::

:::warning
This is only an estimate: it only covers the hourly part and leaves out data transfer, requests, taxes and credits. For real amounts, use Budgets and Cost Explorer.
:::

::checks
