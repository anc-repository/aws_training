---
step: worker-stop
---

What happens when the worker is down? Stop the worker in the lab terminal:

```bash {runsOn=lab}
sudo systemctl stop cloudalbum-worker
```

Post a few comments on the test users' photos in the App preview, then look at the inbox queue:

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.inboxUrl }}" --attribute-names ApproximateNumberOfMessages
```

Check your mailbox for these comments' notification emails, then start the worker again:

```bash {runsOn=lab}
sudo systemctl start cloudalbum-worker
```

:::expected
Comments still succeed (Publish happens in the api process and has nothing to do with the worker), and notification emails still arrive; only the inbox queue backs up, and it is consumed once the worker starts,
filling in the `sqs-copy` records in `/api/admin/notifications/deliveries`.
:::

:::tip
You can also let the runner stop and restore the worker automatically: `npm run exp -- notification --label after --scenario worker-stop --fault-via ssm --instance-id {{ target.instanceId }}`
(it stops the worker at 5 s and starts it at 50 s, recording the inbox queue depth in between).
:::

::checks
