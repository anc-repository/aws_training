---
step: layers
---

The CTO's last question: "Do we also need to buy Shield Advanced or turn on GuardDuty?" Look at the Shield page in the console (**look only, do not subscribe**) and answer with the table below.

::console-link[Open the WAF & Shield console]{link=wafv2.webAcls}

| Layer | Service | Status in this card | What it covers |
|---|---|---|---|
| Layer 3/4 perimeter | Security groups, NACLs | Tightened (steps 3, 4) | Allows by IP and port; security groups only have allow rules |
| Layer 3/4 DDoS | Shield Standard | On automatically, no extra charge | Common network and transport layer attacks such as SYN floods and UDP reflection |
| Large-scale DDoS response | Shield Advanced | Not subscribed | Annual subscription; DDoS response team, protection against scaling costs, finer attack visibility |
| Layer 7 filtering | AWS WAF | Enabled (steps 5–7) | Rate-based rules, managed rule groups, IP sets, geo match; can block |
| Threat detection | GuardDuty | Not enabled in this version | Analyzes CloudTrail, VPC Flow Logs and DNS logs; only produces findings, never blocks, never reads HTTP content |
| Multi-account management | Firewall Manager | Not involved | Rolls out WAF rules, Shield Advanced protection and security group policies across an organization |

:::warning
Shield Advanced is billed on an annual commitment. If you subscribe by mistake in the console, contact AWS immediately — the platform cannot reclaim it.
:::

:::why
**Credential stuffing is not DDoS.** Credential stuffing is low-rate layer 7 abuse that looks like normal sign-ins: Shield does not handle it, and WAF's `rate-login` and managed rule groups (Bot Control if needed) are the right tools.
GuardDuty solves a different kind of problem: an instance that, after being compromised, scans outward, connects to mining pools or makes anomalous API calls. It complements WAF rather than replacing it.
:::

:::expected
You can explain that Shield Standard already applies to this distribution automatically; that Shield Advanced has nothing to do with this scenario's credential stuffing; and that GuardDuty cannot see the payloads from steps 2 and 9, let alone block them.
:::

::checks
