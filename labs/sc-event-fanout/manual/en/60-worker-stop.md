---
step: worker-stop
---

What happens when the worker is down? The runner posts a comment every 5 seconds, stops `cloudalbum-worker` through the platform management channel (SSM) at 5 s and starts it again at 50 s,
recording the inbox queue depth and how the `sqs-copy` delivery records fill in:

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario worker-stop --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=notification id=worker-stop label=after}

While it runs, you can watch the inbox queue from another workbench terminal:

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.inboxUrl }}" --attribute-names ApproximateNumberOfMessages
```

When it is done, confirm that the worker is back:

```bash {runsOn=lab}
systemctl is-active cloudalbum-worker
```

Finally, put two emails side by side in your mailbox: this step's "comment notification" (through SNS) and step 3's "verification code / password reset" (through SES).
Compare the senders, the body format and the bottom of each email.

:::expected
Comments still succeed (Publish happens in the api process and has nothing to do with the worker), and notification emails still arrive; the inbox queue backs up during the outage and is consumed once the worker starts,
filling in the `sqs-copy` records in `/api/admin/notifications/deliveries`; `systemctl is-active` prints `active`.
:::

:::tip
When no delivery channel is available, run with `--fault-via skip` and follow the prompts to run `sudo systemctl stop cloudalbum-worker` and `sudo systemctl start cloudalbum-worker` by hand in the lab terminal.
:::

::checks
