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

## 平台（集成时补充，2026-10-14）

各实现者在翻译中新增的译名（docs/implementation-notes.md 各 `## i18n-*` 小节），集成时统一。同一中文词有两种含义时分行写明。

| zh-CN | ja | en |
| --- | --- | --- |
| 待人工处理清单 | 要対応リスト | manual-handling list（画面标题 Manual-handling list） |
| 待人工处理 / 需人工处理（状态） | 要対応 | Needs you |
| 我已处理，重新核对 | 対応済み、再確認 | Handled, recheck |
| 交叉校验（对比实验的上传结果） | 照合 | cross-check |
| 对账 / 核对（报告、证书） | 照合 | reconcile / check |
| 降级（检查改为手动判定） | 格下げ | degraded |
| 降级（服务、应用的健康状态） | 低下 | Degraded |
| 释放（环境） | 解放 | release |
| 释放未完成 | 解放未完了 | Cleanup incomplete |
| 复扫 | 再スキャン | rescan |
| 吊销（证书） | 失効 | revoke / revoked |
| 撤回（徽章） | 取り消し | withdrawn |
| 已核验 | 検証済み | verified |
| 证据 / 可信度 | 証拠 / 信頼度 | evidence / confidence |
| 打码 | マスク | mask |
| 分享链接 | 共有リンク | share link |
| 体检（平台体检） | 点検 | health check |
| 预期中断 | 想定内の中断 | expected outage |
| 预期警告 | 想定内の警告 | expected warning |
| 管理通道（平台管理通道） | 管理チャネル（プラットフォームの管理チャネル） | management channel (platform management channel) |
| 运行器 | ランナー | runner |
| 平台动作 | プラットフォーム操作 | platform action |
| 佐证 | 裏付け | corroboration |
| 归属（资源归属确认） | 所有の確認 | ownership |
| 漂移 | ドリフト | drift |
| 前导键 | プレフィックスキー | leader key |
| 费用计 | 費用メーター | cost meter |
| 变体 | バリアント | variant |
| 起始档位 | 開始構成 | start profile |
| 本地档（本地实现） | ローカル階層 | local tier |
| 驱动 | ドライバー | driver |
| 接入应用 | アプリへの組み込み | wire into the app |
| 工作台终端 / 实验机终端 | ワークベンチのターミナル / ラボ用インスタンスのターミナル | Workbench terminal / Lab terminal（正文可写 lab instance terminal） |
| 应用预览 | アプリのプレビュー | App preview |
| 架构 / 架构图 | 構成 / 構成図 | Architecture |
| 开始时 / 完成后 | 開始時 / 完了後 | At start / When done |
| 有 vs 没有 | ある場合 vs ない場合 | With vs without |
| 整体对比 | 全体の比較 | Overall comparison |
| 详细（折叠） | 詳しく | Details |
| 费用档位（视觉组件 `visual.metric.cost`） | コスト区分 | Cost tier |
| 专项（学习路径标题） | …パス | … path |

## 卡片内容中的 AWS 与应用用语

| zh-CN | ja | en |
| --- | --- | --- |
| 入口链 / 路径段 / 路径头 | 入口チェーン / 経路セグメント / 経路ヘッダー | entry chain / path segment / path header |
| 探针 / 探测端点 | プローブ / プローブ用エンドポイント | probe / probe endpoint |
| 感知器 | 検知処理 | sensor |
| 源站 / 回源 / 锁定源站 | オリジン / オリジンへのリクエスト / オリジンのロック | origin / origin request / origin lock-down |
| 分配（CloudFront） | ディストリビューション | distribution |
| 失效（CloudFront） | 無効化 | invalidation |
| 托管区域 | ホストゾーン | hosted zone |
| 暂存桶 | ステージングバケット | staging bucket |
| 原图 / 原图桶 / 展示桶 | 元画像 / 元画像バケット / 表示用バケット | original image / original-image bucket / display bucket |
| 前缀令牌 | プレフィックストークン | prefix token |
| 预留并发 / 预置并发 | 予約済み同時実行 / プロビジョニングされた同時実行 | reserved / provisioned concurrency |
| 死信队列 / 重驱动 | デッドレターキュー / 再処理（リドライブ） | dead-letter queue / redrive |
| 发件身份 / 配置集 / 沙盒 | 送信元 ID / 設定セット / サンドボックス | sender identity / configuration set / sandbox |
| 订阅过滤策略 | サブスクリプションフィルターポリシー | subscription filter policy |
| 撞库 | クレデンシャルスタッフィング | credential stuffing |
| 管理员 IP | 管理者 IP | admin IP |

CloudAlbum 应用（`frontend/`）本轮不本地化：手册引用应用界面上的中文时保留原文，括号里附译文（「覆盖同名缩略图」（同名サムネイルの上書き））。

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
