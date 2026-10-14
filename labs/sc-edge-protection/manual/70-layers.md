---
step: layers
---

CTO 的最后一个问题：“是不是还要买 Shield Advanced、开 GuardDuty？”在控制台看一看 Shield 页面（**只看，不要订阅**），对照下表回答。

::console-link[打开 WAF 与 Shield 控制台]{link=wafv2.webAcls}

| 层次 | 服务 | 本卡状态 | 管什么 |
|---|---|---|---|
| 三/四层边界 | 安全组、NACL | 已收紧（第 3、4 步） | 按 IP 与端口放行；安全组只有允许规则 |
| 三/四层 DDoS | Shield Standard | 自动生效、不另收费 | SYN 洪泛、UDP 反射等常见网络层与传输层攻击 |
| 大规模 DDoS 响应 | Shield Advanced | 不订阅 | 按年订阅；DDoS 响应团队、扩容费用保护、更细的攻击可见性 |
| 七层过滤 | AWS WAF | 已启用（第 5～7 步） | 速率规则、托管规则组、IP 集合、地理匹配；可以阻断 |
| 威胁检测 | GuardDuty | 本版不启用 | 分析 CloudTrail、VPC 流日志与 DNS 日志；只产生发现，不阻断，不看 HTTP 内容 |
| 多账户统一管理 | Firewall Manager | 不涉及 | 在组织内统一下发 WAF 规则、Shield Advanced 保护与安全组策略 |

:::warning
Shield Advanced 按年承诺计费。如果你在控制台误点了订阅，请立即联系 AWS 处理——平台无法回收它。
:::

:::why
**撞库不是 DDoS。** 撞库是低速率、看起来像正常登录的七层滥用：Shield 不处理它，WAF 的 `rate-login`、托管规则组（必要时 Bot Control）才是对口的工具。
GuardDuty 解决的是另一类问题：实例被入侵后对外扫描、连接矿池、调用异常的 API。它与 WAF 互补，而不是替代。
:::

:::expected
你能说清：Shield Standard 已经对这个分配自动生效；Shield Advanced 与本场景的撞库无关；GuardDuty 看不到第 2、9 步的载荷，也不会阻断它们。
:::

::checks
