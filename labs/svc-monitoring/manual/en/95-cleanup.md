---
section: cleanup
---

- Reclaim deletes the monitoring stack (the alarms, dashboard, ops-alarms topic and subscriptions go with it) and removes the agent snippet.
- Custom metrics already sent cannot be deleted; once sending stops they expire naturally under the retention policy and stop costing money.
- If you did the optional "resolution" step, confirm that `DetailedMonitoring` is back to `false`; otherwise you are billed per instance for the rest of the session.
- If the instance is still "Stopped" after the instance-stop experiment, reclaim works as usual; but start it before continuing with other steps.
