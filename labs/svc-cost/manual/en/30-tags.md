---
step: tags
---

The project budget filters costs on the cost allocation tag `Project=CloudAlbum`. Every module stack carries the stack-level tags `Project` and `Module`, but user-defined tags only show up as groups in cost data after they are
**activated** as cost allocation tags in Billing.

```bash {runsOn=workstation}
aws ce list-cost-allocation-tags --tag-keys Project Module --region us-east-1
```

If the tag is not active (or not in the list), run the platform action (it does not take effect on the spot):

::platform-action{id=cost-activate-tags}

:::expected
`Status` of `Project` is `Active`. If it has not taken effect yet you can still carry on: the project budget will keep showing 0 — which is itself something to observe.
:::

:::why
New tag keys take a while to appear in the list of activatable tags, take a while longer to take effect after activation, and do not apply to costs from before the activation (see the official docs for timings);
in AWS Organizations only the management account can activate them. That is why this step is best done the day before the lab.
:::

:::tip
The Cost Explorer API may be billed per request, and the platform caches its check result for 30 minutes; do not run the command above over and over in the terminal.
:::

::checks
