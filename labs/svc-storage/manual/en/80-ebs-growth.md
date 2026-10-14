---
step: ebs-growth
---

(Optional) Temporarily "fill up" the data volume: uploads still succeed (the bytes are in S3), but comment writes fail (SQLite is still on this disk). The script releases the placeholder file automatically when it ends.

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario ebs-growth --upload
```

::experiment{module=storage id=ebs-growth label=after}

:::danger
If the script is interrupted, run the command below in the lab terminal to release the placeholder file; otherwise the data volume stays full if you keep the environment:

```bash {runsOn=lab}
sudo bash experiments/storage/faults/balloon.sh release
```
:::

::checks
