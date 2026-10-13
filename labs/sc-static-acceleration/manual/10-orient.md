---
step: orient
---

在应用预览里打开相册，用浏览器开发者工具的 Network 面板看缩略图请求：主机是 `cloudalbum-{{ session.env }}-storage-media-…s3.{{ session.region }}.amazonaws.com`，
URL 带 `X-Amz-Signature` 等签名参数，刷新一次 URL 就变一次。

然后记录 before：运行器持续 5 分钟加载相册 JSON、30 张缩略图与 1 张展示图。

```bash {runsOn=workstation}
npm run exp -- cdn --label before --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=before}

:::expected
每张缩略图都是一次到 S3 的请求；报告中源站请求数与访问量成正比。
:::

:::tip
选做：`npm run exp -- cdn --label before --scenario ttfb --upload` 记录首字节时间，只作参考（工作台与实验机同在东京）。
:::

::checks
