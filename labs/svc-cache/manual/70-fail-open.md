---
step: fail-open
---

（选做）缓存故障：运行器在第 30 秒临时撤销 `sg-cache` 上来自实验机安全组的 6379 入站规则，第 80 秒恢复；期间持续读时间线。
故障脚本在工作台用你的身份执行，需要两个安全组 ID：

```bash {runsOn=workstation}
export CACHE_SG_ID=$(aws elasticache describe-cache-clusters --cache-cluster-id "{{ var.replicationGroupId }}-001" --query "CacheClusters[0].SecurityGroups[0].SecurityGroupId" --output text)
export APP_SG_ID={{ target.sgId }}
npm run exp -- cache --label after --scenario fail-open --fault-via local --upload
```

::experiment{module=cache id=fail-open label=after}

:::warning
如果运行器中途被中断，立即恢复规则：`bash experiments/cache/faults/revoke-sg.sh restore`（同一终端，环境变量仍在）。
结束检查会确认 6379 规则仍在。
:::

:::expected
故障期间错误数为 0，路径头出现 `cache=redis@elasticache:error-bypass`，延迟退回无缓存水平；cache 模块短暂变为 degraded，恢复后回到正常。
:::

::checks
