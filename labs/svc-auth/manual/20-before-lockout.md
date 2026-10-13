---
step: before-lockout
---

记录 before：对一个测试账号连续提交 30 次错误密码，记录响应码序列。**不要**对管理员账号运行（会被锁定，脚本会拒绝）。

```bash {runsOn=workstation}
npm run exp -- auth --label before --scenario brute-force --param email=atl-test-3@example.com --upload
```

::experiment{module=auth id=brute-force label=before}

:::expected
报告中的序列类似 `401×5, 423×…` 或出现 `429`：本地驱动按账号计数锁定，Nginx 再按来源限速。
:::

:::why
**本地锁定的代价**：计数要存在某个地方。单实例时在本机数据库；扩成多实例后必须共享状态，否则攻击者把请求分散到不同实例就能绕过。
Cognito 的临时锁定是全局统一的，不需要应用操心。
:::

::checks
