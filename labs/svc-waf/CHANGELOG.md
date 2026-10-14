# svc-waf 变更说明

## 1.0.0

- AWS WAF：Web 应用防护：第一版内容（04 v2）：lab.yaml、手册、检查与小测；status 由 planned 改为 beta。
- 与卡片文档（service-cards-1 §7）的差异见 lab.yaml 文件头注释与 docs/implementation-notes.md 的 wave1-waf 小节：
  锁定源站用 `--set CDN_DIRECT_ACCESS=admin-ip`（cdn hook 读 --set），切 Block 用 `enable waf --param RuleAction=block`，
  Block 步骤用服务端证据（源站 nonce 计数为 0），路径头降为 warn（R-16）。
- wave1-integration（仍为 1.0.0，发布前修订）：`webacl-count`、`webacl-block` 改用 `where` 选规则（检测引擎不支持 `[?(...)]` 过滤表达式）；
  徽章换成本卡自己的 WAF 徽章（原为 SNS 徽章的复制品）；`bypass` after 从工作台（管理 IP 白名单内）运行时以服务端看到的客户端地址判定，
  不再误报“未锁定”。
