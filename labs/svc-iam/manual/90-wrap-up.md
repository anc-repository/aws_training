---
section: wrap-up
---

## 你做到了什么

- 让应用第一次拥有 AWS 身份：实例角色的临时凭证，不落盘、自动轮换。
- 确认了 IMDSv2 挡住只能发 GET 的 SSRF，并在 CloudTrail 中认出了 `AssumedRole` 与 `ASIA`。

## 考点回顾

- IAM 用户、组、角色、策略；AWS 托管、客户托管、内联策略；实例配置文件与 `iam:PassRole`。
- STS 临时凭证与自动轮换；`aws:TokenIssueTime` 与撤销会话（实例需要换新会话才能恢复）。
- IMDSv2 与 SSRF、跳数限制；SDK 默认凭证链的优先级。
- 策略评估逻辑：显式 Deny 优先、默认拒绝，`GetCallerIdentity` 例外；权限边界、SCP 与身份策略的关系。
