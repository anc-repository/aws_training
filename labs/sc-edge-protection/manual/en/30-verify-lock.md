---
step: verify-lock
---

Prove the origin is locked. An attacker has three paths: hitting the Elastic IP directly on 80/443, hitting 8080 directly, and forging a request that "comes from CloudFront". Look at what stops each one.

**1. The lab instance's security group**: 80/443 only allow the admin IP.

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }} --query "SecurityGroupRules[?IsEgress==\`false\`].[FromPort,ToPort,CidrIpv4,CidrIpv6]" --output table
```

**2. The origin security group**: 8080 only references CloudFront's managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`). A request to 8080 from the workbench times out:

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ var.originSgId }} --query "SecurityGroupRules[?IsEgress==\`false\`].[FromPort,PrefixListId]" --output table
curl -s -o /dev/null -m 8 -w "8080 from workstation: %{http_code}\n" "http://{{ target.publicIp }}:8080/api/health/live" || echo "8080 from workstation: timeout"
```

::console-link[Open the lab instance's security group]{link=ec2.securityGroup sgId="{{ target.sgId }}"}

**3. The second lock beyond the prefix list**: other people's CloudFront distributions come from the same ranges, so Nginx also checks `X-Origin-Verify`. The security group stands in front,
so this layer can only be tested from the lab instance itself — request 8080 without the verification header:

```bash {runsOn=lab}
curl -s -o /dev/null -w "8080 without X-Origin-Verify: %{http_code}\n" http://127.0.0.1:8080/api/health/live
```

**4. The attacker's view**: connect to the lab instance directly from somewhere that is **not** the admin IP. Open CloudShell (its egress address belongs to AWS and is not on your security group's allow list):

::console-link[Open CloudShell]{link=cloudshell.home}

```bash {runsOn=cloudshell}
curl -s -o /dev/null -m 8 -w "%{http_code}\n" "http://{{ target.publicIp }}/api/health/live" || echo timeout
curl -s -o /dev/null -m 8 -w "%{http_code}\n" "https://{{ var.cdnDomain }}/api/health/live"
```

:::expected
Item 1 only has 80 and 443 for `{{ workstation.publicIp }}/32`; item 2 has a single rule for 8080 + `pl-…`, and the workbench request to 8080 times out;
item 3 returns **403**; item 4 times out directly and returns 200 through the distribution.
:::

:::why
**Why not just run the `waf/bypass` experiment?** The workbench's public egress is the admin IP itself, so probing port 80 from the workbench always gets through and the experiment would report "not locked".
Judge "can attackers go around it" from the attacker's position (CloudShell), and "what the rules really are" from the server-side security group configuration — not from the response some client sees.
:::

::checks
