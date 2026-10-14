# 09 · 多语言与视觉化（ATL Web）

> 记录 I1～I7（“文字太多、多用图像；增加日语与英语，默认日语”）在平台网页中的实现方式。
> 多语言（i18n）部分由 i18n 实现者补充；本文件先收录“视觉组件”部分（实现者 prep-visual）。

---

## 视觉组件（I6）

视觉组件替代大段文字：服务图标、自动生成的架构图、步骤类型与卡片指标图标、进度环与条形图。它们只提供组件，
页面何时使用见 V9；页面本身由各页面的实现者接入。

| 路径 | 内容 |
|---|---|
| `platform/web/src/ui/glyphs/` | `<ServiceGlyph>`、`<ServiceChip>`、`<GroupSymbol>`、`<PseudoGlyph>`；40 个图案（`motifs.tsx`）；视觉组件共用的 t() 适配层（`visualI18n.tsx`、`visualMessages.ts`） |
| `platform/web/src/ui/glyphs/registry.generated.ts` | 由 `modules/registry.yaml` + `labs/_catalog/taxonomy.yaml` 生成的图标数据（不要手改） |
| `platform/web/scripts/gen-glyph-registry.mjs` | 生成脚本；`--check` 只比较 |
| `platform/web/src/ui/diagram/` | `<ArchDiagram>`：模型 `model.ts` → 确定性布局 `layout.ts` → SVG；泳道定义 `lanes.ts`；数据适配 `adapters.ts` |
| `platform/web/src/ui/charts/` | `<StepTypeIcon>` / `<StepTypeTag>`、`<MetricIcon>` / `<MetricStrip>`、`<ProgressRing>`、`<BarChart>` |
| `platform/web/src/dev-gallery/` | 组件展示页（开发专用）、样本卡片、无头截图自查 `shoot.py` |

共同约束（I6 g，沿用 08 §6、§8）：只用 `tokens.css` 已有的 token，不新增颜色；颜色只由 CSS 类决定，**不写 `style` 属性**
（CSP `style-src 'self'`，样式随组件的 `.css` 打包成同源文件）；不加载任何外部资源与字体；不使用 AWS 官方图标素材
（05 §2.10、08 §6.9）；所有图形要么 `aria-hidden`，要么 `role="img"` + 完整的文字说明；`forced-colors` 下退回系统色。

### V1 视觉语言

**图标网格**：24 × 24 的 viewBox；底是圆角方块（`x=.5 y=.5 23×23 rx=5`），图案画在 4～20 的活动区（四边各留 4）。
**线条**：线宽 2、圆头圆角、不填充；需要实心的小元素用 `.f`（填 `--on-ink`），需要遮住底线的“旋钮”用 `.k`（填组色、描 `--on-ink`）。
线宽随尺寸缩放：16px 时 1.33px、24px 时 2px。

**配色**：方块填组色 `--cat-base` / `--cat-a`～`--cat-f`（05 §2.10 的类别色，亮暗两套已有），图案用 `--on-ink`
（亮色主题为白、暗色主题为近黑，因此暗色下是“浅色方块 + 深色图案”）。逐对计算的对比度：

| 组合 | 亮色 | 暗色 | 要求 |
|---|---|---|---|
| `--on-ink` 图案 / 缩写 对 组色方块 | 4.73（C）～ 8.45（base） | 7.13（B）～ 9.63（C） | 图形 ≥ 3:1；缩写是文字 ≥ 4.5:1 ✓ |
| 组色方块 对 `--bg` / `--surface` / `--surface-2` | ≥ 4.07 | ≥ 6.05 | 图形边界 ≥ 3:1 ✓ |
| 架构图连线 `--border-strong` 对 `--surface` | 3.64 | 3.49 | ≥ 3:1 ✓ |
| 新增 / 选做的强调 `--accent` 对 `--surface` | 6.04 | 6.78 | ≥ 3:1 ✓ |

组色只是辅助编码（与 05 §2.10 一致）：六个组色在色觉模拟下并不都能区分，所以服务的身份由**图案**承担，组另有
**几何符号**（基础 方块、A 三角、B 菱形、C 圆、D 六边形、E 加号、F 两条横线），在 ≥ 40px 的徽章模式里画在左上角。

**尺寸分级**（`size`，像素）：

| 尺寸 | 画法 | 用途 |
|---|---|---|
| 16 / 20 / 24 / 32 | 方块 + 图案（不画文字：16px 下缩写不可读） | 行内、列表、条形图标签、服务地图格 |
| ≥ 40（`GLYPH_BADGE_MIN`） | 徽章模式：缩小的图案 + 等宽缩写（taxonomy 的 abbr）+ 左上角组符号 | 简介页“你将学到”、服务卡标题 |

`variant="icon" | "badge"` 可以强制某种画法；`tone="ghost"`（虚线框、无底色）与 `tone="muted"` 用于“还没有”的位置。
认不出的 id 画中性方块 + 前 3 个字符，不抛错。浏览器与 Nginx 不是模块，用 `<PseudoGlyph>`（中性底、`--text-2` 图案）。

### V2 数据来源与生成

`node platform/web/scripts/gen-glyph-registry.mjs` 读取 registry 与 taxonomy，生成 `registry.generated.ts`：

- 每个模块：`group`、`awsService`、`abbr` / `short` / `serviceId`（taxonomy）、`fn`（taxonomy 的机能短句，zh-CN 源语言）、`type`；
- 依赖 `deps`：`hard`（requires 条目没有 `when`，或 `when` 只写本模块自己的开关且取值属于 `ownedValues`；`severity: warn` 的条目只是提醒，不算）、
  `cond`（`when` 里有其他选项）、`anyOf`（全部由模块组成的备选，如 waf 的 `cdn | load-balancer`）、`soft`（原样）；
  `need` 中的 `VAR=value` 按“另一个模块的开关 + ownedValues”换成模块（`STORAGE_DRIVER=s3` → storage），`!=` 与普通配置项不产生依赖；
- 别名：taxonomy 服务 id 与附属服务 → 模块（`s3` → storage、`ebs` → ec2、`shield` → waf）；与模块 id 同名的服务 id 不做别名
  （taxonomy 的 `config` 是 AWS Config = compliance 模块，而模块 `config` 是 Parameter Store）。

生成文件提交进仓库，SPA 不在运行时读 YAML。一致性由两处保证：单元测试 `glyphs.test.tsx` 把 YAML 以 `?raw` 读入、
用同一个函数重新生成并逐字比较；CI 可以直接跑 `--check`。

### V3 图标清单（40）

| 模块 | 缩写 | 组 | 图案 | 模块 | 缩写 | 组 | 图案 |
|---|---|---|---|---|---|---|---|
| ec2 | EC2 | base | 带引脚的芯片 | analytics | FH | C | 三股流汇成箭头 |
| network | VPC | A | 边框内两个子网块 | image-processing | λ | D | 图片（山与太阳） |
| cdn | CF | A | 地球（经纬线） | queue | SQS | D | 两个方块 + 出队箭头 |
| dns | R53 | A | 路标（左右两块指示牌） | notification | SNS | D | 扩音器 |
| tls | ACM | A | 证书徽章（圆章 + 绶带） | email | SES | D | 信封 |
| waf | WAF | A | 砖墙 | scheduler | SCH | D | 日历 |
| load-balancer | ALB | A | 一分三 | tagging | REK | D | 取景框 + 瞳孔 |
| autoscaling | ASG | A | 实例 + 左右扩展箭头 | social-api | APIG | D | 花括号 + 点 |
| iam | IAM | B | 钥匙 | shell-access | SSM | E | 终端提示符 |
| auth | CUP | B | 用户 | logging | CWL | E | 带行的文档 |
| identity-pool | CIP | B | 用户 + 上传箭头 | monitoring | CW | E | 坐标折线 |
| secrets | SEC | B | 密码框（三个圆点） | tracing | XR | E | 三个节点的调用链 |
| config | PS | B | 两个滑块开关 | audit | CT | E | 带勾的夹板 |
| kms | KMS | B | 挂锁 | threat-detection | GD | E | 盾牌 + 感叹号 |
| storage | S3 | C | 桶 | compliance | CFG | F | 勾选清单 |
| shared-fs | EFS | C | 文件夹 + 两个挂载点 | vuln-scan | INS | F | 放大镜 + 感叹号 |
| database | RDS | C | 圆柱 | cost | BUD | F | 美元符号 |
| cache | ELC | C | 闪电 | db-proxy | RDSP | F | 多条连接汇入小圆柱 |
| social-store | DDB | C | 表格 | workflow | SFN | F | 状态机（一分二） |
| backup | BAK | C | 回转箭头 + 时钟指针 | ami | IMB | F | 叠层 |

ec2 的组是 `base`（registry 原样），用中性的 `--cat-base`；A～F 六组各一色。16 / 24 / 48px 在亮暗两种主题下的截图见 V7。

### V4 `<ArchDiagram>`

```tsx
<ArchDiagram input={archInputFromCatalogCard(card)} size="mini" decorative />      // 目录卡片缩略图
<ArchDiagram input={archInputFromIntro(intro)} />                                  // 简介页首屏：开始时 → 完成后
<ArchDiagram input={{ start: ['iam', 'storage'], targets: ['cdn'], options: { CDN_MEDIA_ORIGIN: 's3' } }} mode="after" />
```

**输入** `ArchInput`：`start`（开始时已启用的模块，即 startProfile 中 `kind: module` 的条目）、`targets`（目标模块，
`{ id, from?, to?, optional? }` 或 id 字符串）、`options`（影响连线的设置，例如 `CDN_MEDIA_ORIGIN=s3`）。id 可以是模块 id 或
taxonomy 服务 id。`adapters.ts` 提供三种数据形状的转换：目录卡片（`startProfiles[select=default].modules` + `targets`）、
简介页（`resources.provisions[kind=module]` + `resources.targets`）、lab.yaml（`startProfile.provisions` + `targetModules`，
各条目的 `set` 合并为 `options`）。

**模型**（`buildArchModel`，纯函数）：

- 开始时 = ec2 ∪ start ∪ 硬依赖闭包；完成后 = 开始时 ∪ targets ∪ 硬依赖闭包；
- 完成后节点状态：`new`（新增，强调色实线圈 + 右上角加号）、`optional`（选做目标，强调色虚线圈）、`changed`（目标已在开始时存在、
  只改配置，强调色点线圈）、`implied`（依赖带入，中性虚线圈）、`present`；
- 开始时，目标模块若有本地实现（`from` 不是 `none`），在它完成后的位置画 `ghost`：虚线框 + 等宽的驱动名（`sqlite`、`local`、
  `nginx` …，不翻译）。两张图同一位置一个是“本地实现”、一个是 AWS 服务，“有 vs 没有”一目了然；
- 入口：同一状态里有 ALB（load-balancer）就以 ALB 为入口，否则画 EC2 上的 Nginx；两者共用一个格位；
- network（VPC）不占泳道，画成包住“入口～数据”泳道的虚线边界框（新增 / 变更时用强调色）。

**泳道**（自左向右）：客户端 → 边缘 → 入口 → 计算 → 数据与消息 → 运维与安全。每个模块固定属于一条泳道、泳道内的上下
顺序固定（`LANE_RANK`），主请求路径排在第 0 行：浏览器 → CloudFront → 入口 → EC2 → 第一个数据服务，因此主路径是一条水平线。

| 泳道 | 模块（自上而下） |
|---|---|
| 客户端 | 浏览器 |
| 边缘 | cdn、waf、tls、dns |
| 入口 | nginx / load-balancer、social-api、auth、identity-pool |
| 计算 | ec2、autoscaling、scheduler、image-processing、workflow、tagging |
| 数据与消息 | db-proxy、database、cache、storage、shared-fs、social-store、queue、notification、email、analytics |
| 运维与安全 | iam、secrets、kms、config、shell-access、logging、monitoring、tracing、audit、threat-detection、compliance、vuln-scan、backup、cost、ami |

**布局**（`layoutArch`，纯函数、整数坐标）：按两个状态的**并集**排一次，两张图共用同一套坐标；并集中没有节点的泳道折叠；
一条泳道超过 `maxRows`（full 6、mini 4）时按列折行。尺寸：full 每列 120px、每行 76px、图标 36px、标签 11px；mini 每列 30px、
每行 26px、图标 18px、无文字（6 条泳道的 mini 图约 200 × 110px）。

**连线**（`edgesFor` + `routeEdges`）：

| 规则 | 线型 |
|---|---|
| 浏览器 →（CloudFront）→ 入口 → EC2；EC2 → 各数据与消息服务（有 db-proxy 时经过它）；SNS → SES / SQS；Firehose → S3；SQS 或 S3 → Lambda；Lambda / Step Functions → Rekognition；API Gateway → DynamoDB、SNS 或 SQS；Identity Pool → S3；CloudFront → S3（`CDN_MEDIA_ORIGIN=s3`） | 实线 + 箭头（flow） |
| WAF、ACM 挂在 CloudFront（没有时挂在 ALB / Nginx）；Auto Scaling 挂在 EC2 | 短虚线、无箭头（attach） |
| 浏览器 → Route 53 / User Pool / Identity Pool；API Gateway → User Pool | 长虚线 + 箭头（aux） |
| registry 硬依赖中还没有连线的两个非运维节点 | 点线（dep） |
| 运维与安全泳道 | 横切关注点，不画连线 |

连到新增 / 选做节点的连线用强调色。路径是水平切线的三次贝塞尔：同一节点同一侧的多条连线按对端位置错开端口（与本节点同一行
的连线留在中心），跨两列以上的同行连线向下弓到两行之间，同列相邻两行画竖线（full 从标签下方起止），不相邻则从右侧绕弧。

**尺寸与模式**：`size="full"` 默认 `mode="pair"`（“开始时 → 完成后”两张图并排，窄屏上下排列、箭头转为向下），带泳道标题、
标签与图例（只列出图中出现的状态）；`size="mini"` 默认 `mode="after"`。`fit="scroll"`（full 默认）时每张图在自己的横向滚动容器里
（`tabindex=0`，有说明“可横向滚动”），页面本身不横向滚动；`fit="scale"` 与 mini 按容器宽度缩放。

**可访问性**：每张图 `role="img"`，`<title>`“构成图（开始时）”，`<desc>` 是按泳道顺序列出的服务与“追加：…”的文字摘要
（Intl.ListFormat）；卡片里旁边已有文字时用 `decorative`（`aria-hidden`）。

### V5 基础图形组件

| 组件 | 说明 |
|---|---|
| `<StepTypeIcon type size? label?>`、`<StepTypeTag type>` | lab.schema 的 6 种步骤类型：控制台（窗口 + 指针）、CLI（终端）、脚本（文档 + 播放）、代码（尖括号）、观察（眼睛）、对比实验（烧瓶）。与 `ui/Icon.tsx` 同风格（20 网格、描边 1.6、currentColor） |
| `<MetricIcon kind=… compact?>`、`<MetricStrip>` | 难度（四段递增条，实心段数 = 等级）、时长（时钟 + `Intl.NumberFormat` 的分钟，ja「90 分」、en「90 min」、zh「90分钟」）、费用档位（三个等宽 `$`，未达到的变淡；08 §6.6 不用红绿、不写金额）、部署等级（速度表指针，A 快 → D 慢；05 §3.4 不写分钟数）。可见文字是短标签，读屏另有视觉隐藏的指标名；`compact` 时只有图标，`role="img"` + “指标：值” |
| `<ProgressRing value max? size? label tone?>` | 单一数值的环：完成部分 `--viz-after`（tone `pass` / `neutral` 可选），底环 `--viz-grid`；≥ 40px 时中心显示 Intl 百分比；`role="img"` + “标签：60%” |
| `<BarChart data caption …>` | 横向条形图，用 `<table>` 实现：行标题 + 装饰性的条（SVG 属性定宽，`preserveAspectRatio="none"` 随列宽伸缩）+ 数值文字，所以图表本身就是数据表视图（08 §6.12、§8.4）；颜色按角色 `after` / `before` / `third`；条上有 `<title>` 悬停提示 |

### V6 文字与 t() 适配层

i18n 框架与视觉组件并行开发，视觉组件只调用 `useVisualI18n().t(key)`，键都以 `visual.` 开头（泳道名、浏览器、开始时 / 完成后、
图例、步骤类型、指标、组名、40 个模块的机能短句）。查找顺序：

1. `<VisualI18nProvider lang translate>` 提供的外部 `translate(key)`（返回 `null` / `undefined` 表示没有）；
2. 内置词典 `visualMessages.ts` 的所选语言 → en → zh-CN（I2 回退链；开发模式下回退时在控制台警告一次）。

没有 Provider 时语言取 `<html lang>`（i18n 运行时会设置它，切换语言时整棵树重新挂载），取不到时用 ja（I1）。内置词典的 ja、en
在类型上必须覆盖 zh-CN 的全部键（缺键编译不过），单元测试另外检查占位符一致。数字、分钟、百分比、列表一律用 Intl 按语言格式化。
AWS 服务名与产品短名（CloudFront、RDS Proxy…）、驱动名（`sqlite`）、缩写不翻译（I3）。

### V7 组件展示页与截图自查

- 开发服务器启动后打开 `http://127.0.0.1:5174/src/dev-gallery/`（查询串 `?theme=light|dark&lang=ja|en|zh-CN&card=<id>`）。
  `/__dev/*` 已代理给 API 的 dev-server，所以不用那个前缀；生产构建只以根目录 `index.html` 为入口，展示页不进 `dist/`。
- 内容：40 个图标（16 / 24 / 48px、缩写、短名、机能）、色调与非模块节点、步骤类型、指标、进度环、条形图，以及 17 张样本卡片
  （`sampleCards.ts`，取自 `labs/_catalog/catalog.yaml`）的 mini 与 full 架构图。
- 自查：`python platform/web/src/dev-gallery/shoot.py --base http://127.0.0.1:<port> --out <dir>`（系统 Chrome，无头）在
  亮 / 暗 × 1280px、亮 / 暗 × 400px、ja / en / zh-CN 下全页截图，并检查：页面不横向滚动、40 个图标都在、没有控制台错误与失败请求。
  2026-10-14 的结果：5 种组合全部通过（400px 下 `scrollWidth = clientWidth = 400`）。

### V8 测试

`npm test -w @atl/web`（vitest）中的三个文件：

- `ui/glyphs/glyphs.test.tsx`：生成文件与 YAML 一致；40 个模块（registry 顺序）各有一个图案、组与组符号，缩写唯一且 ≤ 4 字符；
  依赖推导；别名；每个模块在 16 / 24 / 48px 下的渲染（< 40 无文字、≥ 40 有缩写）；三种语言的标签；内置词典覆盖与占位符一致。
- `ui/diagram/diagram.test.tsx`：每个模块都有泳道；同样的输入（打乱顺序）得到完全相同的模型与布局；新增 / ghost / 变更 / 选做 /
  依赖带入 / VPC 边界框 / ALB 与 Nginx 共用格位；40 个模块单独作为目标时布局无 NaN、每条连线都有路径；端口错开与主路径水平；
  mini 尺寸上限；6 张样本卡片的布局快照与一张 mini 图的标记快照（`__snapshots__/`）。
- `ui/charts/charts.test.tsx`：6 种步骤类型图案互不相同；Intl 分钟与百分比；指标的读屏文字；条形图的表格语义与宽度计算。

### V9 页面接入指引（供各页面实现者参考）

| 画面（I6） | 建议 |
|---|---|
| c 卡片目录 | 卡片：`<ServiceGlyph size={32}>`（主服务）+ `<ArchDiagram size="mini" decorative input={archInputFromCatalogCard(card)}>`；难度 / 时长 / 费用 / 部署等级换成 `<MetricStrip>`；服务地图的格子用 `<ServiceGlyph size={24..32}>` + `<GroupSymbol>` 组标题 |
| d 卡片简介页 | 首屏 `<ArchDiagram input={archInputFromIntro(intro)}>`（pair）；“你将学到”用 `<ServiceChip showFunction size={40}>` 列表；“有 vs 没有”可用 `mode="before"` / `mode="after"` 两张图左右放进对比卡片 |
| e 工作台手册 | 步骤标题前 `<StepTypeIcon>` 或 `<StepTypeTag>`；步骤顶部的相关服务用 `<ServiceGlyph size={16..20}>` 一行 |
| f 报告与学习 | 完成度 `<ProgressRing>`；各领域 / 各步骤的量用 `<BarChart>`（它本身就是数据表） |

页面若已有自己的 i18n Provider，只需在应用根部包一层 `<VisualI18nProvider lang={useLocale()}>`（可选：传入 `translate`
让主词典覆盖 `visual.*` 键）；不包也能工作（跟随 `<html lang>`）。

### V10 与指示的差异、待定事项

- 展示页地址是 `/src/dev-gallery/` 而不是 `/__dev/gallery`：`/__dev` 在 `vite.config.ts` 中代理给 API；为了不修改 SPA 的路由表与 Vite 配置，
  用独立的开发入口。
- “40 个模块按 A～F 六组配色”：registry 中 ec2 的组是 `base`，因此实际是 6 个组色 + 中性的 `--cat-base`。
- 生成脚本没有挂进 `npm run build`（`platform/web/package.json` 不在视觉组件的修改范围内）；一致性由单元测试与 `--check` 保证。
  建议集成时加 `"gen:glyphs": "node scripts/gen-glyph-registry.mjs"` 并在 CI 跑 `--check`。
- `visual.fn.*`（40 个机能短句）的 ja / en 是视觉组件内置的译文；卡片元数据的“服务与机能名”翻译（I5）完成后，应以术语表
  `platform/web/src/i18n/glossary.md` 为准统一，并通过 `translate` 覆盖或直接改内置词典。
