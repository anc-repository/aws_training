---
section: cleanup
---

- 自动回收会先禁用再删除分配（需要数分钟，回收进度会单独提示），再删除缓存策略、响应头策略、OAC 与 CloudFront Function。
- 媒体桶随 storage 一起清空后删除；回收前 cdn 注入的桶策略语句随 storage 栈更新一起移除。
- 本卡片不开启 HSTS；如果你在练习中手工开启过，浏览器会记住它，务必使用很小的 `max-age`。
