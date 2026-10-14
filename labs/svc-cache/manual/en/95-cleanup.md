---
section: cleanup
---

- **Billed hourly**: nodes are billed from creation; the platform's reclaim deletes the replication group, the subnet group and `sg-cache` directly (the cache holds no authoritative data).
- If you ran fail-open and the runner was interrupted, make sure the 6379 rule on `sg-cache` has been restored (`revoke-sg.sh restore`); otherwise the timeline stays on error-bypass after you keep the environment.
- While you keep the environment, the node keeps being billed by the hour; end it as soon as you no longer need it.
