---
step: invalidation
---

缓存的代价是“更新不会立刻生效”。这一步比较两种更新方式：创建失效，和换一个新的对象键（版本化文件名）。

1. 打开相册的 `/lab` 页面，在 cdn 卡片上点“覆盖同名缩略图”：经 CDN 刷新仍是旧图（`X-Cache: Hit`，`Age` 递增），直连已是新图。
2. 点“创建失效”，或在工作台终端自己创建（把路径换成 `/lab` 页面显示的那张缩略图）：

```bash {runsOn=workstation}
aws cloudfront create-invalidation --distribution-id {{ var.distributionId }} --paths "/media/variants/*"
aws cloudfront list-invalidations --distribution-id {{ var.distributionId }} --query "InvalidationList.Items[].[Id,Status]" --output table
```

3. 失效变为 `Completed` 后刷新：先 Miss，再显示新图。
4. 再点“版本化键”：新图立即出现，不需要等待，也不消耗失效配额。

:::wait{typical=2 max=10}
失效需要传播到全部边缘站点，通常几十秒到几分钟。
:::

:::saa{domain=performance confusable="失效 vs 版本化文件名"}
发布频繁的静态资源用带内容哈希的文件名（版本化），`index.html` 用 `no-cache` 或很短的 TTL；失效只在必要时使用，超出每月免费配额的失效路径要收费。
:::

::checks
