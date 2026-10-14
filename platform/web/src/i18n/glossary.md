# 用语表 / 用語集 / Glossary

翻译界面词典（`platform/web/src/i18n/ja/*.ts`、`en/*.ts`）和卡片内容（`lab.yaml` 的 `{ zh-CN, ja, en }`、`manual/ja/`、`manual/en/`）时使用的统一译名（docs/platform/09-i18n-and-visual.md §1.9、§2，决定 I3）。

- 日语用です／ます体；英语用自然的技术英语（不直译中文语序），句首大写、按钮用动词开头（“Start lab”）。
- 称呼学员：zh-CN “你”，ja 不写主语（必要时“あなた”），en “you”。
- 不翻译（三种语言写法相同）：AWS 服务与产品名（Amazon CloudFront、AWS WAF、Amazon S3 …）、CLI 命令与参数、代码、资源名与 ID、API 路径、环境变量、文件名、`{{ … }}` 变量、`{name}` 占位、指令（`::check{…}` 等）、错误码（`LAB_PLANNED` …）。
- 新词先加到本表再用；同一个中文词在一种语言里只用一个译名。

## 平台

| zh-CN | ja | en |
| --- | --- | --- |
| ATL 实验平台 | ATL ラボプラットフォーム | ATL Lab Platform |
| 非 AWS 官方 | AWS 非公式 | Not affiliated with AWS |
| 卡片 | カード | card |
| 卡片目录 | カード一覧 | Card catalog |
| 服务卡片 | サービスカード | service card |
| 场景卡片 | シナリオカード | scenario card |
| 即将推出（占位卡片） | 近日公開 | Coming soon |
| 学习路径 | 学習パス | learning path |
| 阶段 | ステージ | stage |
| 必修 / 选修 / 可选 | 必修 / 選択 / 任意 | required / elective / optional |
| 我的学习 | 学習状況 | My learning |
| 我的实验 | 実験履歴 | My labs |
| 实验（一次会话） | ラボ（セッション） | lab (session) |
| 会话 | セッション | session |
| 工作台 | ワークベンチ | workbench |
| 实验机 | ラボ用インスタンス | lab instance |
| 工作站 | ワークステーション | workstation |
| 环境 | 環境 | environment |
| 起始状态 | 開始状態 | start state |
| 目标模块 | 対象モジュール | target module |
| 预置（provision） | 事前準備 | provisioning |
| 报价 | 見積もり | quote |
| 费用等级（低 / 中 / 高） | コスト区分（低 / 中 / 高） | cost tier (low / medium / high) |
| 按小时计费 | 時間課金 | billed hourly |
| 预检 | 事前チェック | preflight |
| 延长 | 延長 | extend |
| 节省模式 | 節約モード | saving mode |
| 保留环境 | 環境の保持 | keep the environment |
| 回收 | 回収 | reclaim |
| 清理 | クリーンアップ | cleanup |
| 残留资源 | 残存リソース | leftover resources |
| 步骤 | ステップ | step |
| 手册 | 手順書 | manual |
| 检查 | チェック | check |
| 自动检查 / 手动确认 | 自動チェック / 手動確認 | automatic check / manual confirmation |
| 常见问题（pitfall） | よくあるつまずき | common pitfall |
| 对比实验 | 比較実験 | comparison experiment |
| 基线 / 处理组 | ベースライン / 変更後 | baseline / treatment |
| 小测 | 小テスト | quiz |
| 徽章 | バッジ | badge |
| 掌握度 | 習熟度 | mastery |
| 证书 | 修了証 | certificate |
| 报告 | レポート | report |
| 分享副本 | 共有コピー | shared copy |
| 验证页 | 検証ページ | verification page |
| 学员 / 助教 / 观察者 | 受講者 / アシスタント / 閲覧者 | learner / assistant / observer |
| 区域 / 灾备区域 | リージョン / DR リージョン | Region / DR Region |
| 账号 | アカウント | account |
| 只读 | 読み取り専用 | read-only |
| 未翻译 | 未翻訳 | Not translated |

## 卡片内容（00-overview.md 的标题）

lint C-12 与卡片介绍页按这些标题找到概览的各节，翻译后的 `manual/<lang>/00-overview.md` 必须用下面的写法（labs:lint I5）。

| zh-CN | ja | en |
| --- | --- | --- |
| 背景 | 背景 | Background |
| 对比实验预告 | 比較実験の予告 | Comparison experiments |
| 为什么组合在一起 | なぜ組み合わせるのか | Why combine them |
| 平台模式说明 | プラットフォームモードについて | Platform mode notes |

## SAA 领域

| zh-CN | ja | en |
| --- | --- | --- |
| 安全 | セキュリティ | Secure |
| 弹性 | 回復性 | Resilient |
| 高性能 | 高パフォーマンス | High-performing |
| 成本优化 | コスト最適化 | Cost-optimized |
