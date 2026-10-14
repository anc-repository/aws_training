---
section: cleanup
---

- 身份池、Uploader 角色与暂存桶随会话回收删除；暂存桶先清空、中止未完成的分片上传再删除（回收器处理）。
- 原图桶（storage）与 User Pool（auth）是起始状态的资源，同样由平台回收；User Pool 的删除保护由回收器先关闭。
- 不要把浏览器或实验脚本拿到的临时凭证复制到其他地方使用：它们约一小时内过期，角色删除后立即失效，但在此之前可以写你自己的前缀。
- 在独立模式下手工停用：`scripts/module disable identity-pool`（先清空暂存桶并中止未完成的分片上传，再分离 PolicyArn、删除栈）；
  `users.identity_id` 保留，重新启用时继续使用。
