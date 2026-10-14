/**
 * ja（日本語）：命名空间 frame。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/frame';

export default {
  routes: {
    login: 'ログイン', // 登录
    callback: 'ログインを完了しています', // 正在完成登录
    signedOut: 'ログアウトしました', // 已退出
    setup: '初回設定', // 首次设置
    catalog: 'カード一覧', // 卡片目录
    card: 'カードの紹介', // 卡片简介
    quiz: '小テスト', // 小测
    track: '学習パス', // 学习路径
    workspace: 'ワークベンチ', // 工作台
    sessions: '実験履歴', // 我的实验
    session: 'セッションの詳細', // 会话详情
    end: '終了と回収の進捗', // 结束与回收进度
    report: 'ラボレポート', // 实验报告
    experiment: '比較実験', // 对比实验
    manual: '要対応リスト', // 待人工处理清单
    certificates: '修了証とバッジ', // 证书与徽章
    certificate: '修了証の詳細', // 证书详情
    learning: '学習状況', // 我的学习
    settings: '設定', // 设置
  },
  bar: {
    progress: '進捗', // 进度
    learning: '学習状況 →', // 我的学习 →
    certificates: '修了証 →', // 证书 →
  },
  notFound: {
    mySessions: '実験履歴', // 我的实验
    body: '{notFound} アドレス {path} に対応する画面はありません。リンクの期限が切れているか、入力に誤りがある可能性があります。', // {notFound} 地址 {path} 没有对应的画面；链接可能已过期，或输入有误。
    back: '実験履歴に戻る', // 回到我的实验
    missingBody: '削除されたか、このプラットフォームのものではない可能性があります。', // 它可能已被删除，或者不属于这个平台安装。
    canRetry: '再試行できます。', // 可以重试了。
  },
  residualOf: '{labId}（{t} のラボ）', // {labId}（{t} 的实验）
  actions: {
    cancel: 'ラボをキャンセル', // 取消实验
    extend: 'ラボを延長', // 延长实验
    end: 'ラボを終了', // 结束实验
  },
  pill: {
    session: 'セッション {sid} · {state}', // 会话 {sid} · {state}
    tier: '、コスト区分{tier}', // ，费用档位{tier}
  },
  onboarding: '初回設定はまだ完了していません。先にラボを続けて、後で 設定 › プラットフォーム から見直せます。', // 首次设置还没有完成：可以先继续实验，之后在 设置 › 平台 中重看。
  footerCatalog: 'カタログ {v}', // 目录 {v}
  login: {
    devSubInvalid: '英数字、- と _ のみ使えます（1～64 文字）', // 只能包含字母、数字、- 与 _（1～64 个字符）
    redirecting: '移動しています…', // 正在跳转…
    callbackFailed: 'ログインが完了していません', // 登录未完成
    signedOut: 'ログアウトしました', // 已退出
  },
  crumbs: 'パンくずリスト', // 面包屑
  catalog: 'カード一覧', // 卡片目录
  about: ' · 約 {n} 分 ·', //  · 约 {n} 分钟 ·
  otherParams: '…（ほかのパラメータは UsePreviousValue=true）', // …（其余参数 UsePreviousValue=true）
  ws: {
    catalog: '‹ カード一覧', // ‹ 目录
    title: 'ワークベンチ', // 工作台
    notFoundTitle: 'このセッションは見つかりません', // 没有找到这个实验会话
    notFound: '削除されたか、URL が間違っている可能性があります。すべてのセッションは「実験履歴」で確認できます。', // 它可能已被删除，或者地址有误。可以在“我的实验”中查看全部会话。
  },
  manualPage: {
    severity: {
      all: 'すべて', // 全部
      BLOCKING: 'ブロック', // 阻塞
      REVIEW: '要確認', // 需复核
      INFO: '情報', // 信息
    },
    crumbs: 'パンくずリスト', // 面包屑
    mySessions: '実験履歴', // 我的实验
    title: '要対応リスト', // 待人工处理清单
    sub: 'セッション横断のまとめ · 各項目にコンソールのリンクと CLI コマンドがあり、対応後に再確認できます', // 跨会话汇总 · 每项都有控制台链接与 CLI 命令，处理后可重新核对
    remask: 'マスクに戻す', // 恢复打码
    unmask: '完全な名前を表示', // 显示完整名称
    filters: '絞り込み', // 筛选
    severityLabel: '重要度', // 严重级别
    billing: '課金方式', // 计费方式
    all: 'すべて', // 全部
    count: '全 {n} 件', // 共 {n} 项
    countHourly: '全 {n} 件（うち {h} 件はブロックかつ時間課金）', // 共 {n} 项，其中 {h} 项阻塞且按小时计费
    emptyTitle: '解放されていないリソースはありません。', // 没有未释放的资源。
    viewSessions: '実験履歴を見る', // 查看我的实验
    emptyBody: '回収の失敗や再スキャンで見つかった残存リソースがここに表示されます。', // 回收失败或复扫发现的残留会出现在这里。
    noMatch: '絞り込みに合う項目はありません。', // 没有符合筛选条件的条目。
    clear: '絞り込みを解除', // 清除筛选
    tagNote: 'これらのリソースにはすべて atl:env-id タグが付いているので、コンソールでタグから探せます。対応後に「対応済み、再確認」を押すと、プラットフォームが確認し、すべて対応済みになると回収を終了します。', // 这些资源都带有 atl:env-id 标签，可以在控制台按标签查找。处理后点“我已处理，重新核对”，平台会复核并在全部处理后结束回收。
    previous: '以前のラボ', // 之前的实验
    session: ' · セッション {sid}', //  · 会话 {sid}
    reclaim: '回収の進捗', // 回收进度
    export: 'エクスポート', // 导出
    confirmed: '確認済み：リソースは存在しません', // 已确认：资源已不存在
    still: 'リソースはまだ存在します', // 资源仍然存在
    verifying: '確認しています…', // 正在核对…
    safe: '安全', // 安全
    safeNote: '{safe} 課金対象のリソースではありませんが、残しておくとドメインが削除済みのホストゾーンを指したままになります。', // {safe} 这不是计费资源，但留着会让域名指向已删除的托管区域。
    confirmedNote: '確認済み：リソースは存在しません。', // 已确认：资源已不存在。
    stillNote: 'リソースはまだ存在します。削除が完了したか確認してください。CloudFront や RDS などは削除に時間がかかるため、少し後で再確認できます。', // 资源仍然存在，请确认删除已完成；CloudFront、RDS 等删除较慢，可以稍后再核对。
    slowNote: '確認はまだ続いています。結果が出るとリストは自動で更新されます。少し後でこのページを更新しても構いません。', // 核对仍在进行，结果出来后清单会自动更新；也可以稍后刷新本页。
  },
  preflight: {
    verdict: {
      fix: '要対応', // 需处理
      warn: '注意', // 提示
      pass: '合格', // 通过
      unknown: '検出不可', // 无法检测
    },
    openQuotas: 'Service Quotas を開く', // 打开 Service Quotas
    stackNamePlaceholder: '<削除するスタック名>', // <要删除的栈名>
    items: {
      region: {
        ok: 'リージョンは検証済みの一覧にあります', // 区域在已验证列表中
        title: 'リージョンが検証済みの一覧にありません', // 区域不在已验证列表中
        body: '一部のカードで使うサービスやインスタンスタイプが、このリージョンでは使えない可能性があります（公式ドキュメントを優先してください）。', // 部分卡片依赖的服务或实例类型在这个区域可能不可用（以官方文档为准）。
      },
      'default-vpc': {
        ok: 'デフォルト VPC とデフォルトサブネット', // 默认 VPC 与默认子网
        title: 'デフォルト VPC：このリージョンにデフォルト VPC がありません', // 默认 VPC：这个区域中没有默认 VPC
        body: 'L0 のラボ用インスタンスとワークベンチは、デフォルト VPC のパブリックサブネットに配置します。次のコマンドをご自身で実行してください（プラットフォームはデフォルト VPC を作成も回収もしません）：', // L0 实验机与工作台都放在默认 VPC 的公有子网中。请自己执行下面的命令（平台不会代为创建，也不会回收默认 VPC）：
      },
      'vcpu-quota': {
        ok: 'オンデマンドインスタンスの vCPU クォータ', // 按需实例 vCPU 配额
        title: 'EC2 オンデマンドインスタンスの vCPU クォータが少ない可能性があります', // EC2 按需实例 vCPU 配额可能较低
        body: 'ラボ用インスタンスとワークベンチは同時に動きます。コスト区分が高のカードでは、さらに複数のインスタンスが同時に動きます。', // 实验机与工作台同时运行；高费用卡片还会同时运行多台实例。
      },
      'existing-trail': {
        ok: '既存の CloudTrail 証跡はありません', // 没有已有的 CloudTrail trail
        title: 'アカウントに CloudTrail 証跡がすでにあります', // 账号已有 CloudTrail trail
        body: 'svc-audit などの監査系カードは「読み取り専用での接続」で動作します。', // svc-audit 等审计类卡片会以“只读接入”方式运行。
      },
      guardduty: {
        ok: '有効な GuardDuty はありません', // 没有已启用的 GuardDuty
        title: 'アカウントで GuardDuty が有効になっています', // 账号已启用 GuardDuty
        body: '脅威検出系のカード（svc-threat-detection、sc-threat-compliance）は「読み取り専用での接続」で動作します。', // 威胁检测类卡片（svc-threat-detection、sc-threat-compliance）会以“只读接入”方式运行。
      },
      'config-recorder': {
        ok: '既存の Config レコーダーはありません', // 没有已有的 Config 记录器
        title: 'アカウントに AWS Config レコーダーがすでにあります', // 账号已有 AWS Config 记录器
        body: 'コンプライアンス系のカード（svc-compliance、sc-security-baseline）は「読み取り専用での接続」で動作します。', // 合规类卡片（svc-compliance、sc-security-baseline）会以“只读接入”方式运行。
      },
      inspector: {
        ok: 'Inspector は有効化されていません', // Inspector 未激活
        title: 'アカウントで Amazon Inspector が有効化されています', // 账号已激活 Amazon Inspector
        body: '脆弱性スキャン系のカード（svc-vuln-scan）は「読み取り専用での接続」で動作します。', // 漏洞扫描类卡片（svc-vuln-scan）会以“只读接入”方式运行。
      },
      'access-analyzer': {
        ok: '外部アクセスアナライザー', // 外部访问分析器
        title: 'アカウントに外部アクセスアナライザーがすでにあります', // 账号已有外部访问分析器
        body: '次にプラットフォームのスタックを更新するときに、ExternalAccessAnalyzer を existing にすることをおすすめします。', // 建议在下次更新平台栈时把 ExternalAccessAnalyzer 设为 existing。
      },
      'ses-sandbox': {
        ok: 'SES はサンドボックス外です', // SES 已移出沙箱
        title: 'SES はサンドボックス内です', // SES 处于沙箱
        body: 'メール系のカード（svc-email、sc-event-fanout）では、宛先も事前に検証が必要です。', // 邮件类卡片（svc-email、sc-event-fanout）的收件人也要先验证。
      },
      organizations: {
        ok: '組織の SCP による制限は検出されませんでした（完全には検出できません）', // 未检测到组织 SCP 限制（无法完全检测）
        title: 'アカウントは AWS Organizations に属しているため、SCP の制限を受ける可能性があります', // 账号属于 AWS Organizations，可能受 SCP 限制
        body: '一部のラボ操作が組織のサービスコントロールポリシーで拒否される可能性があります（完全には検出できません）。', // 部分实验操作可能被组织的服务控制策略拒绝（无法完全检测）。
      },
      'codebuild-concurrency': {
        ok: 'CodeBuild の同時実行クォータ', // CodeBuild 并发配额
        title: 'CodeBuild の同時実行クォータが少なめです', // CodeBuild 并发配额较低
        body: 'ラボの開始時に待ち行列が発生する可能性があります。', // 开始实验时可能出现排队。
      },
      'lambda-concurrency': {
        ok: 'Lambda の同時実行クォータ', // Lambda 并发配额
        title: 'Lambda の同時実行クォータが少なめです', // Lambda 并发配额较低
        body: 'ラボの開始時に待ち行列が発生する可能性があります。', // 开始实验时可能出现排队。
      },
      'residual-stacks': {
        ok: '同名リソースの衝突も、残存する cloudalbum-* スタックもありません', // 没有同名资源冲突、没有残留的 cloudalbum-* 栈
        title: 'アカウントに cloudalbum-* スタックが残っています', // 账号中有残留的 cloudalbum-* 栈
        body: 'まず一覧を表示し、自分用モードで残ったものだと確認してから削除してください（削除は元に戻せません）。', // 请先列出它们，确认是自用模式留下的再删除（删除不可撤销）。
      },
      'borrowable-compute': {
        ok: '強い権限のロールが付いたコンピューティングリソースはありません', // 没有挂着高权限角色的计算资源
        title: 'アカウントに強い権限のロールが付いたコンピューティングリソースがあります', // 账号中有挂着高权限角色的计算资源
        body: 'アクセス許可の境界では「既存リソースの借用」を防げません。練習専用のアカウントを使うことを強くおすすめします。', // 权限边界拦不住“借用已有资源”。强烈建议使用专门的练习账号。
      },
    },
  },
} satisfies Dict<typeof zh>;
