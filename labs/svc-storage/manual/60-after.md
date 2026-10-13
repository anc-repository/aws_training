---
step: after
---

用与 before 完全相同的参数再测一次：

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario upload-burst --param fileMb=5 --duration 60s --upload
```

::experiment{module=storage id=upload-burst label=after}

:::expected
实验机网卡收字节只剩 KB 级的签名请求，不再随上传量增长；API 进程 CPU 与时间线 p95 基本不变；before 与 after 两条结果都有效、可比。
:::

:::saa{domain=resilient}
S3 Standard 把对象冗余存储在多个可用区（以官方文档为准），EBS 卷只在单个可用区内冗余；S3 无需预置容量，EBS 卷有固定大小。
:::

::checks
