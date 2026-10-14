---
section: overview
---

## Background

Without Budgets, the app uses the billing dimensions (`billing`) that each module declares in the registry, together with the module on/off history, to list which hourly-billed resources exist right now
and how long each has been running — that is the local list on the left of the `/lab` top bar. It sees "RDS was just turned on" **immediately**, but it cannot see the real bill: data transfer and request charges,
resources created by hand, taxes and credits are all missing. And **this project has no built-in prices at all**: an estimated amount only appears if you copy unit prices from the official pricing pages yourself, with a source and a date.

This card uses AWS Budgets to create two monthly budgets: the project budget filters on the cost allocation tag `Project=CloudAlbum`, and the account budget has no filter. When actual spend passes 80%, or spend is
forecast to go over, you get an email and an SNS notification. Cost Explorer shows the real cost breakdown by the `Module` tag.

:::why
The billing data behind Budgets is refreshed at least once a day (see the official docs), so Budgets works as a monthly guardrail but not for catching "left it on for an hour and forgot" — that is what the local list and idle reminders are for.
Only by looking at both side by side do you get speed and accuracy at the same time.
:::

## What you can see in one session

- **You can see**: how the guardrails are built (two budgets, notifications, a topic, an optional budget action) and why the two sides disagree.
- **You usually cannot see**: this session's costs showing up in Budgets and Cost Explorer (hours to a day later), or forecast alerts (they need about 5 weeks of usage history).
  An alert actually firing usually happens after the session has ended.

## Comparison experiments

This card has no required comparison experiment: the five scenarios in the module docs either depend on the day-level lag of billing data or need an hourly-billed module left idle for hours. Both of the following are optional.

### Snapshot of both sides at the same moment (cost/visibility-lag, optional)

- **Without Budgets (local list)**: resources appear in the list as soon as they are enabled, but there is no money figure.
- **With Budgets**: costs take hours to a day to appear in Budgets and Cost Explorer; during the session they are most likely "not there yet".
- **Where you will see it**: `biz.local_module_items` and `biz.budgets_project_actual` in the report.

### Tag coverage (cost/tag-coverage, optional)

- Cost Explorer groups by `Module`; the "untagged" group only ever lands in the account budget (`biz.untagged_share_pct`).
- It calls `ce:GetCostAndUsage` once, which is billed per request, so it needs explicit confirmation (`--param confirmCharges=yes`).

## Platform mode notes

Activating cost allocation tags needs `ce:UpdateCostAllocationTagsStatus`, which the learner identity does not have: use the platform action "Activate cost allocation tags" on the card,
ideally the day before you start the lab. The `atl-platform-guard` budget that the platform may create at installation belongs to the platform and is separate from this card's two budgets — do not change it.

::platform-action{id=cost-activate-tags}
