---
step: ip-before
---

First "change the IP once" without Route 53: the script associates a temporary Elastic IP with the lab instance, and you will see old IP links break immediately and stay broken.

:::why
L0 has to associate an Elastic IP, or the public IP would change every time the instance is stopped and started. But an Elastic IP can change too: a new instance, a network migration, an accidental release… Hard-coding the IP in links
ties the address and the name together.
:::

The drill script calls the AWS CLI on the workbench as you (`--fault-via local`), and when it ends it always re-associates the original EIP and releases the temporary one:

```bash {runsOn=workstation}
npm run exp -- dns --label before --scenario ip-change-drill --fault-via local --param env={{ session.env }} --upload
```

::experiment{module=dns id=ip-change-drill label=before}

:::expected
It runs for about 5 minutes and prints the `runId` at the end. In the findings, `oldLinkFailures` is above 0 (old IP links kept failing during the drill) and `swapAt` has a value;
`drill.newIp` is the temporary address. After the drill, the lab instance has its original `{{ target.publicIp }}` back.
:::

:::warning
During the drill, the lab instance IP the platform has on record is temporarily invalid: **do not click Check**, and do not close the workbench terminal. If you are interrupted, run:

```bash {runsOn=workstation}
bash experiments/dns/faults/reassociate-eip.sh restore --env {{ session.env }}
```
:::

::checks
