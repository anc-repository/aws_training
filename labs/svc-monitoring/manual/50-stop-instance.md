---
step: stop-instance
---

（选做）这次不停服务，直接停止实验机：工作台上的脚本用你的身份调用 `aws ec2 stop-instances`，保持 4 分钟后再启动，
并等 Session Manager 管理通道恢复。实例 ID 与弹性 IP 都不变。

```bash {runsOn=workstation}
npm run exp -- monitoring --label stop-instance --scenario kill-test --param phase=instance --param instanceDownSec=240 --param instanceId={{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=stop-instance}

:::warning
停实例期间实验机终端与本地检查都不可用，界面显示“预期中断”。脚本在后台运行，退出前一定会把实例启动回来；如果你提前关掉了终端，
到 EC2 控制台确认实例为“正在运行”。继续其他步骤前要先等它恢复。
:::

::console-link[在 EC2 控制台查看实验机]{link=ec2.instance instanceId="{{ target.instanceId }}"}

:::expected
`app-heartbeat` 进入 ALARM 并收到邮件；本地一侧当然什么也没有——它在那台被停掉的实例上。
:::

::checks
