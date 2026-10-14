---
step: fail-open
---

(Optional) A cache failure: at second 30 the runner temporarily revokes the 6379 inbound rule on `sg-cache` that allows the lab instance's security group, and restores it at second 80, while it keeps reading the timeline.
The fault script runs on the workbench as you and needs two security group IDs:

```bash {runsOn=workstation}
export CACHE_SG_ID=$(aws elasticache describe-cache-clusters --cache-cluster-id "{{ var.replicationGroupId }}-001" --query "CacheClusters[0].SecurityGroups[0].SecurityGroupId" --output text)
export APP_SG_ID={{ target.sgId }}
npm run exp -- cache --label after --scenario fail-open --fault-via local --upload
```

::experiment{module=cache id=fail-open label=after}

:::warning
If the runner is interrupted, restore the rule immediately: `bash experiments/cache/faults/revoke-sg.sh restore` (in the same terminal, where the environment variables are still set).
The end-of-lab check confirms that the 6379 rule is still there.
:::

:::expected
There are 0 errors during the failure, the path header shows `cache=redis@elasticache:error-bypass`, and latency falls back to the no-cache level; the cache module is briefly degraded and returns to healthy after the restore.
:::

::checks
