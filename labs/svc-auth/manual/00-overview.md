---
section: overview
---

## 背景

L0 的登录全部由 EC2 实现：argon2id 密码哈希、ES256 JWT、邮箱验证、锁定、找回密码、可选 TOTP。每一项都是自己写、自己维护、自己承担风险的代码。
启用 Amazon Cognito User Pool 后，密码与认证流程交给 AWS：浏览器经 Amplify 直接与 User Pool 交互，EC2 不再经手密码，
只用 User Pool 发布的 JWKS 在本地校验 access token。

:::why
**认证外包了，责任没有全部外包。** 密码哈希、锁定、MFA 由 AWS 负责；但应用客户端允许用户改写哪些属性、令牌校验时检查哪些声明、
登出后旧令牌还能用多久，仍然是我们的设计决定（共享责任模型）。
:::

## 对比实验预告

### 功能矩阵与暴力破解（auth/feature-matrix、auth/brute-force，before 必做）

- **没有 Cognito（local）**：功能矩阵列出本地实现的注册、验证、锁定、TOTP；连续输错密码时依次看到 401 → 423（锁定）/ 429（限速）。
- **有了 Cognito**：MFA、找回密码、临时锁定、联合登录都由 User Pool 提供；令牌由 Cognito 以 RS256 签名。
- **你会在哪里看到**：before 的实验报告；启用后的 `/api/capabilities` 与探测端点；User Pool 与应用客户端的配置。
- **说明**：本版的 after 侧对比通过检查与观察完成（实验脚本的 Cognito 登录需要 `USER_PASSWORD_AUTH`，而本模块的客户端只允许 SRP）。

## 平台模式说明

启用 Cognito 时，`scripts/module` 在工作台以你的身份执行一次钩子 `cognito-passwords`：把起始状态预置的测试账号设为“已确认、密码已知”。
密码只保存在平台参数中，不出现在手册与检查证据里。注册新账号需要一个能收信的邮箱：Cognito 的验证码会真实发出。
