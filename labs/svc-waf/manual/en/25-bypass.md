---
step: bypass-before
---

The origin is not locked yet, so first check whether WAF can be bypassed. `bypass` requests the lab instance's direct entry and 8080 directly:

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario bypass
```

Right now direct access gets through (`originLocked=false`): even after WAF is attached to CloudFront, attackers can hit EC2 directly and go around it. This is exactly what **DEP-018** warns about, and step 4 fixes it.
