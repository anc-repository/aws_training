---
section: cleanup
---

- 回收会删除两个预算、预算动作、金丝雀角色与 cost 主题（预算是全局资源，回收器在 us-east-1 侧核对）。
- **成本分配标签保持激活**，不随卡片停用：停用会让 Cost Explorer 中按标签的历史分组出现断档。
- `cost-rates.yaml` 在实验机数据卷上，随实验机删除；想保留抄录的单价，结束前自己复制一份。
- Cost Explorer API 每次调用都计费，本卡最多手动刷新一次，不要反复刷新。
- 平台的 `atl-platform-guard` 预算不属于本卡，不要修改。
