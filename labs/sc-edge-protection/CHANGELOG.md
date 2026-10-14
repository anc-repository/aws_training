# sc-edge-protection 变更说明

## 1.0.0

- 边缘纵深防护：第一版内容（04 v2）：lab.yaml、手册、检查、小测、开始与完成两张架构图；status 由 planned 改为 beta。
- 与卡片文档（scenario-cards §3.2）的差异见 lab.yaml 文件头注释与 docs/implementation-notes.md 的 wave1-scenarios 小节：
  threat-detection 尚未实现，GuardDuty 选做目标改为讲解与手动确认（模块实现后以选做目标补回，版本 +1）；不使用 waf/bypass 实验，
  “无法绕过”改用安全组规则、实验机本机 8080 的 403 与 CloudShell 直连超时证明。
- cdn、waf 的公共检查引用 svc-cdn、svc-waf 的同名检查：两卡主版本变化时本卡必须同步提升版本。
