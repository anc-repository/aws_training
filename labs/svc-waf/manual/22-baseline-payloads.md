---
step: baseline-payloads
---

记录 **before** 的第二部分：Nginx 的特征拦截。`payloads` 发送一组公开的 WAF 测试载荷（SQL 注入及其 URL / 二次编码 / 大小写注释变体、目录穿越、XSS、请求头里的 Log4Shell 探针字符串、扫描器 User-Agent）。

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario payloads --param target=direct
```

注意 Nginx 的几条正则会**漏掉**二次编码、大小写与注释变体——这正是它的局限，第 7 步用 AWS 托管规则组对照。
