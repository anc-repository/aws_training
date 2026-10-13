---
section: cleanup
---

- **按小时计费**：节点从创建开始计费；平台回收直接删除复制组、子网组与 `sg-cache`（缓存没有权威数据）。
- 做过 fail-open 而运行器中途被中断时，确认 `sg-cache` 的 6379 规则已恢复（`revoke-sg.sh restore`），否则“保留环境”后时间线一直走 error-bypass。
- 选择“保留环境”期间节点继续按小时计费；不再需要时尽早结束。
