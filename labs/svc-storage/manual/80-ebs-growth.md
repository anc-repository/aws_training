---
step: ebs-growth
---

（选做）把数据卷临时“撑满”：上传仍然成功（字节在 S3），但评论写入失败（SQLite 仍在这块盘上）。脚本结束时自动释放占位文件。

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario ebs-growth --upload
```

::experiment{module=storage id=ebs-growth label=after}

:::danger
脚本中途被打断时，在实验机终端执行下面的命令释放占位文件，否则保留环境后数据卷仍是满的：

```bash {runsOn=lab}
sudo bash experiments/storage/faults/balloon.sh release
```
:::

::checks
