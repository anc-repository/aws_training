---
step: sidebyside
---

（选做）同一时间、同一实例上交替走 local 与 s3 两条路径上传，只写 `lab/` 前缀，结束后自动清理：

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario upload-sidebyside --param fileMb=5 --upload
```

::experiment{module=storage id=upload-sidebyside label=after}

:::expected
同一时段内两条路径的“上传完成”耗时与实验机收字节差别与 before/after 的结论方向一致。
:::

::checks
