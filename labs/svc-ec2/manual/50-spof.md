---
step: spof
---

单点故障演练：停止实验机，观察网站，再启动它。先在**工作台终端**开始每 5 秒探测一次（保持运行）：

```bash {runsOn=workstation}
while true; do printf "%s " "$(date +%T)"; curl -sk -o /dev/null -m 4 -w "%{http_code}\n" "https://{{ target.publicIp }}/api/health/live" || echo down; sleep 5; done
```

:::method{kind=console default}
::console-link[打开实验机]{link=ec2.instance instanceId="{{ target.instanceId }}"}

1. “实例状态 → 停止实例”，等状态变为“已停止”，观察工作台上的探测结果。
2. “实例状态 → 启动实例”，等状态变为“正在运行”、探测恢复 200。
3. 确认“公有 IPv4 地址”没有变化。
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
停止后**一定要再启动**。预期中断窗口最长 15 分钟；窗口结束后实例仍未启动，检测就是通道中断，最终复核无法通过，倒计时照常走。
:::

:::wait{typical=10 max=20}
实例停止与启动各需要一到数分钟；CloudTrail 事件历史还有几分钟到十几分钟的延迟，本步骤的检查会自动重试。
:::

:::expected
停机期间探测全部失败（全站不可用）；启动后恢复 200，弹性 IP 不变。
:::

::checks
