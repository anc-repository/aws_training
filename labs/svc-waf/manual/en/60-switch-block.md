---
step: switch-block
---

Once the observation looks fine, switch the managed rule groups to **Block**.

:::tip
`modular-design §9.2` has no `set` subcommand — "changing a parameter" means running `enable` again with the new parameter (a stack update, appendix B-27).
:::

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block --dry-run
```

When you are happy with them, run it (the Web ACL updates the managed rule group's action):

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block
```
:::

:::expected
The managed rule group's `OverrideAction` becomes `None` (its own Block action applies); the check automatically sends a payload carrying a nonce and confirms that it gets 403 and **never reached the origin** (the origin log's count for this nonce is 0).
:::

:::warning
A managed rule group Block returns **CloudFront's 403** without the app's `X-CloudAlbum-Path` header — so client response headers alone cannot tell it from the 403 of Nginx's regexes. Judging "stopped at the edge" needs server-side evidence: the origin never received the request.
:::
