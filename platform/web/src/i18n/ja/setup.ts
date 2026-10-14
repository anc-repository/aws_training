/**
 * ja（日本語）：命名空间 setup。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/setup';

export default {
  title: '', // 首次设置
  sub: '', // 这些信息都来自安装时的检查，不会在你的账号里创建任何资源。
  navLabel: '', // 首次设置步骤
  selectLabel: '', // 切换步骤
  stepOf: '', // 第 {i} / {n} 步 · {name}
  steps: [
    '', // 平台是什么
    '', // 平台体检
    '', // 区域与限额
    '', // 预算与通知
    '', // 已有实验与残留
    '', // 个人资料
    '', // 选择学习路径
  ],
  done: '', // 已完成
  skip: '', // 跳过，稍后在设置中看
  prev: '', // 上一步
  next: '', // 下一步：{name}
  finish: '', // 完成，去卡片目录
  finishToWorkspace: '', // 完成并回到工作台
  saving: '', // 正在保存…
  incomplete: '', // 需要先勾选第 1 步“我已了解”、在第 6 步填写显示名，并在第 7 步选择学习路径。
  s1: {
    invited: '', // 你被邀请为{role}：可以查看学员的目录、进度与报告，不能开始实验，也拿不到 AWS 凭证。
    p1: '', // ① ATL 部署在你自己的 AWS 账号里，实验资源按 AWS 价格计费，账单由你承担。
    p2: '', // ② 每次实验先确认费用；倒计时到期后自动释放资源。可以选择保留环境，但保留期间会持续计费。
    p3: '', // ③ 证书由你自己的平台实例签发，不是 AWS 官方认证，也不代表任何 AWS 认证资格。
    more: '', // 了解更多：证书的性质
    moreText: '', // 本证明由部署在学员自己 AWS 账号中的自托管 AWS Training Lab 实例自动签发，表示该实例记录到持有人完成了所列实验；签名可用于确认内容未被篡改、且出自该实例的签名密钥。签发者与持有人可能是同一人。
    ack: '', // 我已了解
  },
  s2: {
    lead: '', // 平台在安装时检查了这个账号。“需处理”的项目会让开始实验失败，“提示”只影响部分卡片。
    checkedAt: '', // 上次体检：{t}（安装时）
    empty: '', // 安装时的体检结果还没有写入。可以先继续，开始实验时平台会再检查一次。
    passed: '', // 通过 {n} 项：{list}……
    after: '', // 修好之后，下一次开始实验时平台会再检查一次（与本次实验相关的部分）。
    confirmDelete: '', // 我确认要删除（显示删除命令）
    open: '', // 打开
    raw: '', // 检测结果：{text}
    type: '', // 类型
    name: '', // 名称
    roleCol: '', // 所挂角色
  },
  s3: {
    region: '', // 平台区域
    regionFixed: '', // 不可更改，换区域要重新安装
    dr: '', // 灾备区域
    drNone: '', // 未设置：svc-backup 跳过跨区域部分，sc-backup-dr 的灾备步骤不可用
    usEast1: '', // us-east-1 的用途
    usEast1Use: '', // CloudFront、CLOUDFRONT 范围的 WAF 与其 ACM 证书
    limit: '', // 限额
    value: '', // 取值
    maxSession: '', // 单次会话总时长上限
    minutes: '', // {n} 分钟
    hours: '', // {n} 小时（费用档位高的卡片建议 ≤ 12 小时）
    extension: '', // 延长
    extensionValue: '', // {n} 次 × {m} 分钟
    keep: '', // 保留上限
    readyIdle: '', // 就绪空闲时限
    readyIdleValue: '', // {n} 分钟内未进入工作台自动结束
    instanceTypes: '', // 允许的实例类型
  },
  s4: {
    suggestTitle: '', // 建议设置月度预算护栏
    suggest1: '', // 平台可以在账号月度费用超过你设定的金额时提醒你，或暂停开始新实验，或结束正在进行的实验。金额由你按自己的承受能力决定，平台不给参考值。
    suggest2: '', // 设置方法：在 CloudFormation 控制台更新 atl 栈的参数（只在没有进行中的实验时操作）：
    paramAmount: '', // 你的月度金额（大于 0 即创建预算 atl-platform-guard）
    paramEnforcement: '', // notify（只通知）· block-start（默认，超限后不能开始新实验）· end-active（超限后先提醒 10 分钟，再结束进行中的实验）
    openCfn: '', // 打开 CloudFormation 控制台
    delay: '', // AWS Budgets 的数据有延迟（以官方文档为准），它是月度护栏，不能代替每次实验的倒计时。
    budgetName: '', // 预算护栏 atl-platform-guard
    amount: '', // 月度金额
    enforcement: '', // 处理方式
    enforcementText: {
      notify: '', // notify（只通知）
      'block-start': '', // block-start（超限后不能开始新实验）
      'end-active': '', // end-active（超限后提醒并结束进行中的实验）
    },
    stateAt: '', // 状态时间
    mail: '', // 邮件订阅：安装时填写的通知邮箱会收到两封订阅确认邮件（实验通知、告警）。请点邮件中的确认链接，否则收不到到期提醒与释放失败告警。平台无法读取订阅是否已确认。
    tags: '', // 成本分配标签：如果你打算做 svc-cost 或 SAA 主线的成本类卡片，平台动作“激活成本分配标签”需要提前 24～48 小时执行（以官方文档为准），它在相关卡片的会话中提供。
  },
  s5: {
    current: '', // 当前会话
    remaining: '', // 剩余 {t}
    toWorkspace: '', // 回到工作台
    toReclaim: '', // 查看回收进度
    kept: '', // 保留中的环境
    keptText: '', // 来自 {labId} · 保留至 {until}
    manageKept: '', // 管理保留的环境
    residual: '', // 待人工处理的残留
    residualText: '', // {n} 项（按小时计费 {h} 项）
    viewList: '', // 查看清单
    none: '', // 没有进行中的实验，也没有未释放的资源。
  },
  s6: {
    displayName: '', // 显示名
    nameRequired: '', // 显示名不能为空
    certName: '', // 证书署名（默认同显示名）
    notify: '', // 开启浏览器通知（环境就绪、剩余 15 / 5 分钟、已释放、释放未完成；只在页面不可见时发送，尽力送达）
  },
  s7: {
    meta: '', // 最少完成 {n} 张 · 必修约 {h} 小时 · 证书：{cert}
    fixLeft: '', // 还有 {n} 项需处理：{list}。开始实验会在预检阶段失败。
  },
} satisfies Dict<typeof zh>;
