---
step: baseline-payloads
---

记录 **before** 的第二部分：Nginx 的特征拦截。`payloads` 对直连入口发送一组公开的 WAF 测试载荷——SQL 注入及其 URL 编码、
二次编码与大小写注释变体、目录穿越、XSS、请求头里的 Log4Shell 探针字符串、扫描器 User-Agent。

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario payloads --param target=direct --upload
```

::experiment{module=waf id=payloads label=before}

在实验机上看看 Nginx 用的是什么规则：

```bash {runsOn=lab}
grep -n 'ca_block' -A3 /etc/nginx/conf.d/cloudalbum.conf | head -8
```

:::expected
最直白的 `union select`、`<script`、`../` 被 Nginx 以 403 拦截；二次编码、大小写混写加注释的变体直接到达了应用。
这些漏网的变体会在第 9 步与 AWS 托管规则组对照。
:::

::checks
