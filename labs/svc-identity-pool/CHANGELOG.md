# svc-identity-pool 变更说明

## 1.0.0

- Amazon Cognito Identity Pool：终端用户直传 S3：第一版内容（04 v2）：lab.yaml、手册、检查与小测；status 由 planned 改为 beta。
- 与卡片文档的差异见 lab.yaml 文件头注释与 docs/implementation-notes.md 的 wave1-identity-pool 小节（Uploader 角色名带环境名；
  对比实验由测试用户发起，validity 为 functional，以服务端 path-seen 检查佐证；第 5 步拆成 after-bench 与 after-cross 两个实验步骤）。
