---
step: invalidation
---

The price of caching is that updates do not take effect immediately. This step compares two ways to update: creating an invalidation, and switching to a new object key (versioned file names).

1. Open the album's `/lab` page and click “覆盖同名缩略图” (overwrite the thumbnail under the same name) on the cdn card: reloading through the CDN still shows the old image (`X-Cache: Hit`, `Age` increasing).
2. Click “创建失效” (create invalidation), or create one yourself in the workbench terminal:

```bash {runsOn=workstation}
aws cloudfront create-invalidation --distribution-id {{ var.distributionId }} --paths "/media/variants/*"
aws cloudfront list-invalidations --distribution-id {{ var.distributionId }} --query "InvalidationList.Items[].[Id,Status]" --output table
```

3. When the invalidation is `Completed`, reload: first a Miss, then the new image.
4. Then click “版本化键” (versioned key): the new image appears immediately, with no waiting and no invalidation quota used.

:::wait{typical=2 max=10}
An invalidation has to propagate to every edge location, which usually takes tens of seconds to a few minutes.
:::

:::saa{domain=cost confusable="失效 vs 版本化文件名"}
Use file names with a content hash for frequently released static assets, and serve `index.html` with `no-cache` or a very short TTL; use invalidations only when needed, since invalidation paths beyond the monthly free quota cost money.
:::

::checks
