---
section: wrap-up
---

## What you did

- Built cost guardrails: a project budget (filtered by tag) plus an account budget (the catch-all), with actual and forecast notifications sent to email and SNS.
- Looked at the fast-but-rough local list and the accurate-but-slow Budgets side by side, and understood why they disagree.
- Saw that unit prices can only come from your own copies with a stated source — this project has no built-in prices.

## Exam points recap

- AWS Budgets (cost, usage and RI / Savings Plans budgets; actual and forecast alerts; Budgets Actions) versus Cost Explorer, Cost and Usage Reports,
  Cost Anomaly Detection and the Pricing Calculator.
- Cost allocation tags: user-defined vs AWS-generated; must be activated; take time to apply; not retroactive; activated by the management account in an organization.
- CloudWatch billing alarms (`EstimatedCharges`, us-east-1) compared with Budgets.
- Ways to cut costs: On-Demand / Savings Plans / Reserved Instances / Spot; Compute Optimizer; Trusted Advisor; turning off idle resources.
- Recognizing hourly-billed resources: public IPv4, NAT Gateway, interface endpoints, RDS, ElastiCache.
