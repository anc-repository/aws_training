---
step: observe-count
---

When you newly enable managed rule groups, start with Count, read the COUNT records from real traffic, confirm there are no false positives, and only then switch to Block. `false-positive` sends two
**legitimate but suspicious** requests through CloudFront as an admin: a request body over 8 KB and normal text containing `SELECT * FROM`.

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario false-positive --upload
```

::experiment{module=waf id=false-positive label=after}

Then upload a photo in the App preview (`storage` stays local, so the photo is uploaded to `/api/storage/upload` as a large request body). Then, in CloudWatch Logs Insights in **us-east-1**,
choose the log group `{{ var.logGroup }}` and see which rules matched:

```sql
fields @timestamp, httpRequest.uri, action, terminatingRuleId
| sort @timestamp desc
| limit 50
```

The module only delivers BLOCK and COUNT records to the log group. Expand the record of an upload request and find `AWSManagedRulesCommonRuleSet` in `ruleGroupList`:
the matching `SizeRestrictions_BODY` is among the non-terminating matching rules, with action COUNT. You can also filter by rule under "Sampled requests" in the WAF console.

:::expected
Both the large request body and the photo upload succeed: CRS's `SizeRestrictions_BODY` is changed to Count by a **rule action override** in the template, so it counts without blocking;
the normal text with SQL keywords is also only counted for now (the managed rule groups as a whole are still on Count).
:::

:::why
**Why override just one rule?** Deleting the whole core rule set gives up all OWASP-style protection; a rule action override (or a scope-down statement for the upload path) only lets the one false positive through,
and every other rule stays in force.
:::

::checks
