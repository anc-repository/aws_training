---
section: cleanup
---

- **按小时计费**：做完必需步骤就可以提前结束实验；延长与“保留环境”都会继续按 Multi-AZ 的两个实例计费。
- 栈的 `DeletionPolicy: Snapshot` 会留下最终快照；平台回收删除实例（跳过最终快照、删除自动备份）并删除已产生的最终快照，不需要在卡片内 `disable database`。
- 选做的时间点恢复或只读副本：验证完立即删除；中断时手动执行 `aws rds delete-db-instance --skip-final-snapshot --delete-automated-backups`。
- **不要开启删除保护**：它会让回收失败，会话进入 CLEANUP_FAILED。
