---
step: invalidation
---

The price of caching is that updates do not show up immediately. This step compares two ways to update: creating an invalidation, and switching to a new object key (versioned file names).

1. Open the album's `/lab` page and click "覆盖同名缩略图" (overwrite the same-name thumbnail) on the cdn card: reloading through the CDN still shows the old image (`X-Cache: Hit`, with `Age` going up), while direct access already shows the new one.
2. Click "创建失效" (create invalidation), or create one yourself in the workbench terminal (replace the path with the thumbnail shown on the `/lab` page):

```bash {runsOn=workstation}
aws cloudfront create-invalidation --distribution-id {{ var.distributionId }} --paths "/media/variants/*"
aws cloudfront list-invalidations --distribution-id {{ var.distributionId }} --query "InvalidationList.Items[].[Id,Status]" --output table
```

3. Once the invalidation is `Completed`, reload: first a Miss, then the new image.
4. Now click "版本化键" (versioned key): the new image appears immediately, with no waiting and none of the invalidation allowance used.

:::wait{typical=2 max=10}
An invalidation has to propagate to every edge location, which usually takes tens of seconds to a few minutes.
:::

:::saa{domain=performance confusable="失效 vs 版本化文件名"}
Give frequently released static assets file names with a content hash (versioning), and give `index.html` `no-cache` or a very short TTL. Use invalidations only when necessary; invalidation paths beyond the monthly free allowance are charged.
:::

::checks
