---
step: stop-instance
---

(Optional) This time, instead of stopping the services, stop the lab instance itself: the script on the workbench calls `aws ec2 stop-instances` with your identity, keeps it stopped for 4 minutes, starts it again,
and waits for the Session Manager management channel to come back. The instance ID and Elastic IP do not change.

```bash {runsOn=workstation}
npm run exp -- monitoring --label stop-instance --scenario kill-test --param phase=instance --param instanceDownSec=240 --param instanceId={{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=stop-instance}

:::warning
While the instance is stopped, the lab terminal and local checks are unavailable, and the UI shows "expected outage". The script runs in the background and always starts the instance again before it exits; if you closed the terminal early,
confirm in the EC2 console that the instance is "Running". Wait for it to recover before continuing with other steps.
:::

::console-link[View the lab instance in the EC2 console]{link=ec2.instance instanceId="{{ target.instanceId }}"}

:::expected
`app-heartbeat` goes to ALARM and the email arrives; the local side of course has nothing — it lives on the instance that was stopped.
:::

::checks
