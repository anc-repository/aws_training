---
section: wrap-up
---

## 你做到了什么

- 把本地账号迁移进 Cognito User Pool：EC2 不再保存密码哈希，注册、验证、锁定、MFA 由 AWS 提供。
- 看懂了公有应用客户端的配置，以及“可写属性”为什么是应用的责任。
- 说清了 Cognito 令牌的签发者、签名算法与登出语义。

## 考点回顾

- User Pool 与 Identity Pool；ID、access、refresh token；授权码 + PKCE，公有客户端与机密客户端。
- ALB `authenticate-cognito` 只能用于 HTTPS 监听器；API Gateway HTTP API 的 JWT 授权器。
- Lambda 触发器（Pre Sign-up、Pre Token Generation、User Migration）；社交登录与 SAML 联合；托管登录自定义域名证书在 us-east-1。
- 无状态会话是 Auto Scaling 水平扩展的前提；Cognito 与 IAM Identity Center 的适用场景；共享责任模型。
- 选读：托管登录（`COGNITO_LOGIN_MODE=managed`）需要受信 HTTPS 域名，在 `sc-user-identity` 中用 CloudFront 域名完成。
