/**
 * en（English）：命名空间 setup。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/setup';

export default {
  title: 'First-run setup', // 首次设置
  sub: 'All of this comes from the checks run at install time; nothing is created in your account.', // 这些信息都来自安装时的检查，不会在你的账号里创建任何资源。
  navLabel: 'Setup steps', // 首次设置步骤
  selectLabel: 'Switch step', // 切换步骤
  stepOf: 'Step {i} of {n} · {name}', // 第 {i} / {n} 步 · {name}
  steps: [
    'What the platform is', // 平台是什么
    'Platform health check', // 平台体检
    'Region and limits', // 区域与限额
    'Budget and notifications', // 预算与通知
    'Existing labs and leftovers', // 已有实验与残留
    'Profile', // 个人资料
    'Choose a learning path', // 选择学习路径
  ],
  done: 'Done', // 已完成
  skip: 'Skip; review later in Settings', // 跳过，稍后在设置中看
  prev: 'Back', // 上一步
  next: 'Next: {name}', // 下一步：{name}
  finish: 'Finish and go to the catalog', // 完成，去卡片目录
  finishToWorkspace: 'Finish and return to the workbench', // 完成并回到工作台
  saving: 'Saving…', // 正在保存…
  incomplete: 'Check “I understand” in step 1, enter a display name in step 6, and choose a learning path in step 7.', // 需要先勾选第 1 步“我已了解”、在第 6 步填写显示名，并在第 7 步选择学习路径。
  s1: {
    invited: 'You were invited as {role}: you can see the learner’s catalog, progress, and reports, but you can’t start labs or get AWS credentials.', // 你被邀请为{role}：可以查看学员的目录、进度与报告，不能开始实验，也拿不到 AWS 凭证。
    p1: '① ATL is deployed in your own AWS account; lab resources are billed at AWS prices, and you pay the bill.', // ① ATL 部署在你自己的 AWS 账号里，实验资源按 AWS 价格计费，账单由你承担。
    p2: '② Every lab shows the cost first; when the countdown ends, resources are released automatically. You can keep an environment, but it is billed while kept.', // ② 每次实验先确认费用；倒计时到期后自动释放资源。可以选择保留环境，但保留期间会持续计费。
    p3: '③ Certificates are issued by your own platform instance; they are not AWS certifications and don’t represent any AWS certification status.', // ③ 证书由你自己的平台实例签发，不是 AWS 官方认证，也不代表任何 AWS 认证资格。
    more: 'Learn more: what the certificate is', // 了解更多：证书的性质
    moreText: 'This credential is issued automatically by a self-hosted AWS Training Lab instance deployed in the learner’s own AWS account. It states that the instance recorded the holder completing the listed labs; the signature confirms that the content hasn’t been altered and that it comes from that instance’s signing key. The issuer and the holder may be the same person.', // 本证明由部署在学员自己 AWS 账号中的自托管 AWS Training Lab 实例自动签发，表示该实例记录到持有人完成了所列实验；签名可用于确认内容未被篡改、且出自该实例的签名密钥。签发者与持有人可能是同一人。
    ack: 'I understand', // 我已了解
  },
  s2: {
    lead: 'The platform checked this account at install time. Items marked “Fix” make labs fail to start; “Notice” items affect only some cards.', // 平台在安装时检查了这个账号。“需处理”的项目会让开始实验失败，“提示”只影响部分卡片。
    checkedAt: 'Last check: {t} (at install)', // 上次体检：{t}（安装时）
    empty: 'The install-time check results haven’t been written yet. You can continue; the platform checks again when a lab starts.', // 安装时的体检结果还没有写入。可以先继续，开始实验时平台会再检查一次。
    passed: '{n} passed: {list}…', // 通过 {n} 项：{list}……
    after: 'Once fixed, the platform checks again (the parts relevant to that lab) the next time a lab starts.', // 修好之后，下一次开始实验时平台会再检查一次（与本次实验相关的部分）。
    confirmDelete: 'I confirm I want to delete (show the delete command)', // 我确认要删除（显示删除命令）
    open: 'Open', // 打开
    raw: 'Detected: {text}', // 检测结果：{text}
    type: 'Type', // 类型
    name: 'Name', // 名称
    roleCol: 'Attached role', // 所挂角色
  },
  s3: {
    region: 'Platform Region', // 平台区域
    regionFixed: 'Can’t be changed; a different Region requires reinstalling', // 不可更改，换区域要重新安装
    dr: 'DR Region', // 灾备区域
    drNone: 'Not set: svc-backup skips the cross-Region parts and the DR steps of sc-backup-dr are unavailable', // 未设置：svc-backup 跳过跨区域部分，sc-backup-dr 的灾备步骤不可用
    usEast1: 'What us-east-1 is used for', // us-east-1 的用途
    usEast1Use: 'CloudFront, WAF with CLOUDFRONT scope, and its ACM certificate', // CloudFront、CLOUDFRONT 范围的 WAF 与其 ACM 证书
    limit: 'Limit', // 限额
    value: 'Value', // 取值
    maxSession: 'Maximum total time per session', // 单次会话总时长上限
    minutes: '{n} min', // {n} 分钟
    hours: '{n, plural, one {# hour} other {# hours}} (≤ 12 hours recommended for high cost tier cards)', // {n} 小时（费用档位高的卡片建议 ≤ 12 小时）
    extension: 'Extensions', // 延长
    extensionValue: '{n} × {m} min', // {n} 次 × {m} 分钟
    keep: 'Keep limit', // 保留上限
    readyIdle: 'Idle limit after ready', // 就绪空闲时限
    readyIdleValue: 'Ends automatically if you don’t enter the workbench within {n} min', // {n} 分钟内未进入工作台自动结束
    instanceTypes: 'Allowed instance types', // 允许的实例类型
  },
  s4: {
    suggestTitle: 'We recommend a monthly budget guardrail', // 建议设置月度预算护栏
    suggest1: 'When the account’s monthly spend goes over an amount you set, the platform can notify you, stop new labs from starting, or end the running lab. Choose the amount by what you can afford; the platform gives no reference value.', // 平台可以在账号月度费用超过你设定的金额时提醒你，或暂停开始新实验，或结束正在进行的实验。金额由你按自己的承受能力决定，平台不给参考值。
    suggest2: 'How: in the CloudFormation console, update the parameters of the atl stack (only while no lab is running):', // 设置方法：在 CloudFormation 控制台更新 atl 栈的参数（只在没有进行中的实验时操作）：
    paramAmount: 'Your monthly amount (greater than 0 creates the budget atl-platform-guard)', // 你的月度金额（大于 0 即创建预算 atl-platform-guard）
    paramEnforcement: 'notify (notify only) · block-start (default; new labs can’t start once over) · end-active (once over, warn and end the running lab after 10 minutes)', // notify（只通知）· block-start（默认，超限后不能开始新实验）· end-active（超限后先提醒 10 分钟，再结束进行中的实验）
    openCfn: 'Open the CloudFormation console', // 打开 CloudFormation 控制台
    delay: 'AWS Budgets data is delayed (see the official documentation); it is a monthly guardrail and doesn’t replace each lab’s countdown.', // AWS Budgets 的数据有延迟（以官方文档为准），它是月度护栏，不能代替每次实验的倒计时。
    budgetName: 'Budget guardrail atl-platform-guard', // 预算护栏 atl-platform-guard
    amount: 'Monthly amount', // 月度金额
    enforcement: 'Enforcement', // 处理方式
    enforcementText: {
      notify: 'notify (notify only)', // notify（只通知）
      'block-start': 'block-start (new labs can’t start once over)', // block-start（超限后不能开始新实验）
      'end-active': 'end-active (warn and end the running lab once over)', // end-active（超限后提醒并结束进行中的实验）
    },
    stateAt: 'State as of', // 状态时间
    mail: 'Email subscriptions: the notification email entered at install receives two subscription confirmation emails (lab notices and alerts). Open the confirmation links, or you won’t get expiry reminders or release-failure alerts. The platform can’t tell whether the subscriptions are confirmed.', // 邮件订阅：安装时填写的通知邮箱会收到两封订阅确认邮件（实验通知、告警）。请点邮件中的确认链接，否则收不到到期提醒与释放失败告警。平台无法读取订阅是否已确认。
    tags: 'Cost allocation tags: if you plan to do svc-cost or the cost cards of the SAA main path, the platform action “Activate cost allocation tags” has to run 24–48 hours ahead (see the official documentation); it is offered in the sessions of those cards.', // 成本分配标签：如果你打算做 svc-cost 或 SAA 主线的成本类卡片，平台动作“激活成本分配标签”需要提前 24～48 小时执行（以官方文档为准），它在相关卡片的会话中提供。
  },
  s5: {
    current: 'Current session', // 当前会话
    remaining: '{t} left', // 剩余 {t}
    toWorkspace: 'Back to workbench', // 回到工作台
    toReclaim: 'View reclaim progress', // 查看回收进度
    kept: 'Kept environment', // 保留中的环境
    keptText: 'From {labId} · kept until {until}', // 来自 {labId} · 保留至 {until}
    manageKept: 'Manage the kept environment', // 管理保留的环境
    residual: 'Leftovers needing manual cleanup', // 待人工处理的残留
    residualText: '{n, plural, one {# item} other {# items}} ({h} billed hourly)', // {n} 项（按小时计费 {h} 项）
    viewList: 'View list', // 查看清单
    none: 'No lab is running and there are no unreleased resources.', // 没有进行中的实验，也没有未释放的资源。
  },
  s6: {
    displayName: 'Display name', // 显示名
    nameRequired: 'Display name can’t be empty', // 显示名不能为空
    certName: 'Name on certificates (defaults to the display name)', // 证书署名（默认同显示名）
    notify: 'Turn on browser notifications (environment ready, 15 / 5 min left, released, release incomplete; sent only when the page isn’t visible, best effort)', // 开启浏览器通知（环境就绪、剩余 15 / 5 分钟、已释放、释放未完成；只在页面不可见时发送，尽力送达）
  },
  s7: {
    meta: 'Complete at least {n} cards · required about {h} hours · certificate: {cert}', // 最少完成 {n} 张 · 必修约 {h} 小时 · 证书：{cert}
    fixLeft: '{n, plural, one {# item still needs} other {# items still need}} fixing: {list}. Starting a lab will fail at the preflight.', // 还有 {n} 项需处理：{list}。开始实验会在预检阶段失败。
  },
} satisfies Dict<typeof zh>;
