---
step: domain
---

Check the domain you entered, `{{ learner.inputs.domain }}`, in the variables panel. If this account already has a public hosted zone for it (or its parent domain), enter the hosted zone ID too —
then the next step does not need to wait for delegation.

First see where this name resolves right now (it returns nothing if there is no record):

```bash {runsOn=workstation}
dig +short {{ learner.inputs.domain }} @8.8.8.8
dig +short NS {{ learner.inputs.domain }} @8.8.8.8
```

:::tip
If CloudShell or the workbench has no `dig`, run `sudo dnf install -y bind-utils` first. `@8.8.8.8` makes the query bypass the local cache so you see the public resolver's answer directly.
:::

:::expected
Before dns is enabled, the first command usually returns nothing (or an old record you set up elsewhere); the second returns the name's current name servers —
four `awsdns` name servers if a Route 53 hosted zone already exists.
:::

:::why
**Why a subdomain?** If you host only a subdomain such as `lab.example.com`, the main domain's other records (website, email) are not affected, and the parent domain just needs 4 NS records.
Hosting the whole of `example.com` means replacing all its NS records at the registrar, which has a much bigger blast radius.
:::

::checks
