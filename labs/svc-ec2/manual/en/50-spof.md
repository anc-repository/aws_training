---
step: spof
---

Single point of failure drill: stop the lab instance, watch the site, then start it again. First start a probe every 5 seconds in the **workbench terminal** (keep it running):

```bash {runsOn=workstation}
while true; do printf "%s " "$(date +%T)"; curl -sk -o /dev/null -m 4 -w "%{http_code}\n" "https://{{ target.publicIp }}/api/health/live" || echo down; sleep 5; done
```

:::method{kind=console default}
::console-link[Open the lab instance]{link=ec2.instance instanceId="{{ target.instanceId }}"}

1. Choose "Instance state → Stop instance", wait until the state is Stopped, and watch the probe output on the workbench.
2. Choose "Instance state → Start instance", and wait until the state is Running and the probe is back to 200.
3. Check that the "Public IPv4 address" has not changed.
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws ec2 stop-instances --instance-ids {{ target.instanceId }}
aws ec2 wait instance-stopped --instance-ids {{ target.instanceId }}
aws ec2 start-instances --instance-ids {{ target.instanceId }}
aws ec2 wait instance-running --instance-ids {{ target.instanceId }}
```
:::

:::warning
After stopping it, **always start it again**. The expected outage window is at most 15 minutes; if the instance is still not running when the window closes, the check treats it as a lost channel, the final review cannot pass, and the countdown keeps running.
:::

:::wait{typical=10 max=20}
Stopping and starting the instance each take one to a few minutes; the CloudTrail event history lags by a few minutes to over ten minutes, and this step's checks retry automatically.
:::

:::expected
While the instance is stopped every probe fails (the whole site is down); after it starts the probe is back to 200, and the Elastic IP is unchanged.
:::

::checks
