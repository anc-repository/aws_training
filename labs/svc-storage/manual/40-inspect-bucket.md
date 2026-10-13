---
step: inspect-bucket
---

看懂原图桶的安全与成本配置。这些配置由模块模板设置，**只看不改**。

:::method{kind=console default}
::console-link[打开原图桶]{link=s3.bucket bucket="{{ var.rawBucket }}"}

1. “权限”：阻止公有访问四项全开；对象所有权为“强制存储桶拥有者”（ACL 已禁用）；桶策略拒绝非 HTTPS 请求（`aws:SecureTransport`）。
2. “属性”：版本控制已启用；默认加密为 SSE-S3（或 SSE-KMS）；事件通知只开启了“Amazon EventBridge”。
3. “管理”：生命周期规则——原图在 30 天后转为 Standard-IA、非当前版本 30 天后过期、中止未完成的分段上传。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws s3api get-public-access-block --bucket {{ var.rawBucket }}
aws s3api get-bucket-versioning --bucket {{ var.rawBucket }}
aws s3api get-bucket-encryption --bucket {{ var.rawBucket }}
aws s3api get-bucket-notification-configuration --bucket {{ var.rawBucket }}
aws s3api get-bucket-lifecycle-configuration --bucket {{ var.rawBucket }}
```
:::

:::why
**为什么只开 EventBridge 投递？** 同一事件类型、重叠前缀的 S3 事件通知只能有一个目标；统一投递到 EventBridge 后，
image-processing、tagging 等模块各自在自己的栈里建规则消费，互不冲突（MUTEX-004）。
:::

:::saa{domain=cost confusable="Standard-IA vs Intelligent-Tiering"}
Standard-IA 有 30 天最短存储期与 128 KB 最小计费尺寸，适合 MB 级、低频访问的原图；Intelligent-Tiering 对小于 128 KB 的对象不做自动分层。
:::

::checks
