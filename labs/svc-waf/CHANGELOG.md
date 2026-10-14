# svc-waf 变更说明

## 1.0.0

- AWS WAF：Web 应用防护：第一版内容（04 v2）：lab.yaml、手册、检查与小测；status 由 planned 改为 beta。
- 与卡片文档（service-cards-1 §7）的差异见 lab.yaml 文件头注释与 docs/implementation-notes.md 的 wave1-waf 小节：
  锁定源站用 `--set CDN_DIRECT_ACCESS=admin-ip`（cdn hook 读 --set），切 Block 用 `enable waf --param RuleAction=block`，
  Block 步骤用服务端证据（源站 nonce 计数为 0），路径头降为 warn（R-16）。
