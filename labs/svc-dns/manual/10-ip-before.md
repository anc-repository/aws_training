---
step: ip-before
---

先在没有 Route 53 的情况下“换一次 IP”：脚本给实验机关联一个临时弹性 IP，你会看到旧 IP 链接立刻失效，而且不会自己恢复。

:::why
L0 必须关联弹性 IP，否则实例停止再启动后公网 IP 就变了。但弹性 IP 也可能变：换实例、迁移网络、误释放……链接里写死 IP，
就把“地址”和“名字”绑在了一起。
:::

演练脚本在工作台上用你的身份调用 AWS CLI（`--fault-via local`），结束时一定会把原 EIP 关联回去并释放临时 EIP：

```bash {runsOn=workstation}
npm run exp -- dns --label before --scenario ip-change-drill --fault-via local --param env={{ session.env }} --upload
```

::experiment{module=dns id=ip-change-drill label=before}

:::expected
运行约 5 分钟，结束时打印 `runId`。发现中 `oldLinkFailures` 大于 0（旧 IP 链接在演练期间一直失败），`swapAt` 有值；
`drill.newIp` 是临时地址。演练结束后实验机挂回原来的 `{{ target.publicIp }}`。
:::

:::warning
演练期间平台记录的实验机 IP 暂时失效，**不要点“检测”**，也不要关闭工作台终端。如果中途被打断，执行：

```bash {runsOn=workstation}
bash experiments/dns/faults/reassociate-eip.sh restore --env {{ session.env }}
```
:::

::checks
