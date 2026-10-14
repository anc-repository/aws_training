# 09 · 多语言与视觉化（ATL Web）

> 记录 I1～I7（“文字太多、多用图像；增加日语与英语，默认日语”）在平台网页中的实现方式。
> 本文件分两部分：“多语言（I1～I5）”（§1 界面、§2 卡片内容、§3 差异与待办；实现者 prep-i18n）与“视觉组件（I6）”（V1～V10；实现者 prep-visual）。

---

## 多语言（I1～I5）

实现者 prep-i18n。界面（§1）与卡片内容（§2）分开处理：界面文案在前端词典里，内容文案在 `labs/` 的内容文件里，两者共用同一条
回退链（所选语言 → en → zh-CN）与同一个“未翻訳 / Not translated / 未翻译”标记。zh-CN 是源语言，也是唯一必需的语言。

### 1 界面（`platform/web`）

#### 1.1 语言的确定与切换（I1）

| 项目 | 做法 |
|---|---|
| 语言 | `ja`（默认）、`en`、`zh-CN`（`i18n/locale.ts` 的 `LOCALES`） |
| 第一次访问 | 一律日语，不看浏览器语言（`navigator.language` 不参与） |
| 切换入口 | 顶栏（登录后在账号菜单左边，`components/GlobalBar.tsx`）、公开页面右上角（`Shells.tsx` 的 `PublicShell`）、工作台“更多”菜单（`SessionBar.tsx`）。选项固定写成各自的语言：日本語 / English / 中文（带 `lang` 属性，读屏按该语言朗读） |
| 保存 | `localStorage` 的 `atl.locale.v1`（`lib/storage.ts` 的 `STORAGE_KEYS.locale`）；它是唯一依据 |
| 个人资料同步 | 已登录时在顶栏切换后尽力 `PATCH /me { locale }`（失败不影响切换）；服务器上的值目前不回读（见 §3） |
| `<html lang>` | 随当前语言（`applyHtmlLang`）；视觉组件（V6）没有 Provider 时也读它 |
| API 请求 | 每个请求带 `Accept-Language: <当前语言>`（`api/client.ts`）；切换后丢弃 API 缓存（`api.invalidate()`），内容类接口按新语言重新取 |
| 切换方式 | 不整页刷新：`i18n/LocaleRoot.tsx` 以语言为 key 重新挂载应用，服务对象（API 客户端、会话同步）保留 |

#### 1.2 框架选择与运行时

**选择**：自写的轻量运行时，不引入 i18next / react-intl。理由：现有页面已经把文案集中在各目录的 `strings.ts` 常量里
（`S.title`、`L.ui.x` 这样的属性访问遍布页面与纯函数模块），换成 `t('key')` 调用要改动几千处并改变代码形状；自写方案让这些
常量继续是对象属性，只把数据源换成词典，界面代码几乎不变（“只替换键、不改布局”）；同时不增加依赖（无需 `npm install`），
验证页与分享副本这类不加载 React 的产物也能用同一份词典；复数与格式化交给 Intl，需求的子集很小。

| 文件 | 内容 |
|---|---|
| `i18n/zh-CN/<ns>.ts`（17 个命名空间） | 源语言词典：core（应用、导航、账号、错误码、语言、时长单位）、labs、card、learning、settings、setup、report、sessions、ui、workspace、certificates、experiments、end、share、verify、pages、frame |
| `i18n/zh-CN.ts`、`ja.ts`、`en.ts` | 合并后的词典（`npm run i18n:sync` 生成）；`Messages = typeof zhCN` |
| `i18n/ja/<ns>.ts`、`en/<ns>.ts` | 译文骨架：键与 zh-CN 完全相同，值为空字符串表示“未翻译”，行尾注释是 zh-CN 原文 |
| `i18n/runtime.ts` | `msg`、`setLocale()`、`getLocale()`、`subscribeLocale()`、`missingKeys()`（不依赖 React） |
| `i18n/hooks.ts`、`LocaleRoot.tsx`、`LanguageSwitcher.tsx`、`Untranslated.tsx`、`i18n.css` | React 部分 |
| `i18n/text.ts`、`template.ts`、`format.ts`、`meta.ts`、`content.ts`、`dict.ts` | 模板、富文本、Intl 格式化、带文字的常量表、内容按语言读取、词典比较 |
| `i18n/index.ts`、`core.ts` | 入口：页面用 `index`；纯函数模块、分享副本渲染器、各目录 `strings.ts` 用不含 React 的 `core` |
| `i18n/tools/sync.mjs`、`check.mjs` | `npm run i18n:sync`、`npm run i18n:check` |
| `i18n/glossary.md` | 用语表（ja / en 两列） |

**运行时**：`msg` 是 zh-CN 词典的深拷贝。切换语言时按回退链把每个叶子原地改写成当前语言的文案；对象身份不变，所以
`export const S = msg.labs.ui` 这类模块级别名、`withText()` 生成的表都在重新挂载后取到新语言。各目录的 `strings.ts` 保留原来的
导出名（`L`、`SS`、`LS`、`ST`、`SU`、`RP`、`SN`、`CT`、`EX`、`W`、`VT`），改为指向词典。

#### 1.3 文案模板

- `t(template, vars)`：`{name}` 占位；简单复数 `{n, plural, one {# item} other {# items}}`（按 `Intl.PluralRules`，zh-CN / ja
  的源文案不需要复数）。
- `rich(template, { name: <ReactNode> })`：占位换成 React 节点（加粗的 id、链接），语序由译文决定，不再在 JSX 里拼句子。
- `withText(base, texts)`：状态 / 形状 / 色调这类不随语言变化的属性写在代码里，`text` 用 getter 从词典取（`ui/semantics.ts`、
  路由表标题、失败码表等）。
- 文案约定沿用 08 §1.6（称呼“你”、按钮动词开头、不写价格数字），译文风格见 §1.9。

#### 1.4 日期、时间与数字（I1）

`i18n/format.ts` 一律用 Intl，语言取当前界面语言：`fmtClock`、`fmtDate`、`fmtDay`、`fmtNumber`、`fmtPercent`、`fmtMoney`、
`fmtList`、`fmtRelative`。zh-CN 保持原有写法（`10/13 10:42`、`2026-10-13`），ja / en 用 Intl 的本地写法。时长的单位文案在词典
`fmt`（ja「1 時間 5 分」、en「1 hour 5 minutes」）。`lib/format.ts` 的 `formatClock` / `formatDate` 委托给它们。

#### 1.5 词典的同步与检查（I2 的 CI 检查）

- `npm run i18n:sync`：按 zh-CN 命名空间生成 / 更新 ja、en 骨架（新键补空字符串、删掉多余的键、保留已有译文），并重写合并文件。
- `npm run i18n:check`：ja、en 是否覆盖 zh-CN 的全部键、有无多余键、占位符（`{name}` 与复数变量）是否一致、叶子类型、骨架是否已同步。
  未翻译（空字符串）默认算失败；翻译进行中用 `npm run i18n:check -- --allow-empty`（只计数）。`--json` 输出机器可读结果。
  2026-10-14：3482 个键，ja / en 各译 15 个（语言名、时长单位、概览标题），结构问题 0。
- 类型：`Dict<T>` 要求 ja / en 与 zh-CN 同结构（缺键或多键编译不过，`satisfies`）。
- 开发模式（`import.meta.env.DEV` 且不是测试）下切换语言时，把走了回退的键汇总成一条控制台警告。

#### 1.6 回退与“未翻訳”标记（I2）

- 界面词典：空字符串视为缺少，按 所选 → en → zh-CN 取值。界面文案的回退**不加标记**（未翻译期间几乎每个元素都会带标记），
  只在开发模式警告；由 `i18n:check` 保证发布前补齐。
- 内容（§2）：显示了其他语言的卡片标题、简介、手册、小测题目旁加 `<Untranslated>`（ja「未翻訳」、en「Not translated」、
  zh-CN「未翻译」；虚线框小字，`title` 说明原因）。目前用在：目录卡片标题（`CardTile`）、简介页标题（`CardIntroPage`）、
  工作台步骤标题（`StepCard`，手册文件的语言与界面不同）、小测题干（`QuizPage`）。
- 错误：API 错误按 `code` 在前端本地化（`msg.errors`），服务器返回的中文 `detail` 只作补充显示。

#### 1.7 测试

`i18n/i18n.test.tsx`：默认 ja 与 `localStorage`、`<html lang>`、回退链、词典结构（缺键 / 多键 / 占位符为 0、键数 > 1500）、
`msg` 原地改写、复数、`rich()` 语序、Intl 格式、`contentUrl`、内容 404 回退、`untranslated()` 指针、切换器选项。
其余页面测试按 zh-CN 源文案断言：`test/setup.ts` 在每个用例前把语言设为 zh-CN（不写 localStorage）。
`npm run e2e:platform` 同样显式选 zh-CN（`scripts/e2e/platform_e2e.py` 的 `UI_LOCALE_ZH`，像用户选择那样写入 `atl.locale.v1`）；
公开页面顶部多了语言选择框，登录步骤的角色选择改为在 `main` 中查找。

#### 1.8 不在 SPA 里的页面

- **公开验证页**（`public-pages/verify/`，独立 IIFE 包，不加载 React）：语言取 `?lang=` → 已保存的选择 → ja；静态 HTML 的
  文字带 `data-i18n="<key>"`，脚本换成 `VT.static[key]`；页内有 日本語 / English / 中文 链接（保留 `#jws=` 片段）。
  没有脚本时显示 zh-CN 源文案。
- **分享副本**（`pages/share/renderShare.ts`，浏览器端生成）：`ShareMeta.lang` 指定语言（默认当前界面语言），HTML 的
  `lang` 随之。服务器端生成的报告 / 分享 HTML（`platform/api/src/services/reports/html.ts`）本轮未本地化（§3）。

#### 1.9 翻译者须知（I3）

- 用语表 `platform/web/src/i18n/glossary.md`（zh-CN / ja / en 三列）；新词先进表再用。
- 不翻译：AWS 服务与产品名、CLI 命令、代码、资源名与 ID、API 路径、环境变量、`{name}` 占位、`{{ … }}` 变量、指令、错误码。
- ja 用です／ます体；en 用自然的技术英语，按钮动词开头。
- 流程：在 `i18n/ja/<ns>.ts`、`en/<ns>.ts` 中填空字符串（行尾注释是原文）→ `npm run i18n:check -- --allow-empty` → 全部译完后
  不带参数运行，CI 以它为准。

### 2 卡片内容（`labs/`、`scripts/labs`、`platform/shared`、`platform/api`）

#### 2.1 写法（I4）

```yaml
title:                                  # 字符串 = zh-CN；对象 = 按语言
  zh-CN: Amazon CloudFront：内容分发与边缘缓存
  ja: Amazon CloudFront：コンテンツ配信とエッジキャッシュ
  en: "Amazon CloudFront: content delivery and edge caching"
summary: 给 EC2 直出的相册加一层 CloudFront……   # 仍是 zh-CN，ja / en 回退
```

- `lab.yaml` v2 中学员看到的文本字段（04 §3.3 中写成 `anyOf: [ { type: string … }, { $ref: '#/$defs/l10n' } ]` 的字段）、
  检查定义（标题、说明、手动确认的问题与选项、常见问题）、`quiz.yaml`（题干、选项、解析）、学习路径（标题、摘要、阶段、备注、
  证书标题）、`taxonomy.yaml`（类别、服务名、领域、时长档、费用档、部署等级）都可以这样写。zh-CN 必填，ja、en 可选。
- 手册：`manual/*.md`（或 `manual/zh-CN/*.md`）是源语言；译文放 `manual/ja/<同名>.md`、`manual/en/<同名>.md`，front matter
  相同，`{{ … }}`、指令、代码块保持原样。00-overview.md 的标题用用语表中的译名（背景 / 比較実験の予告 / なぜ組み合わせるのか…）。
- 旧内容不用改：没有本地化对象、没有 `manual/<lang>/` 的卡片照旧通过 lint，ja / en 产物整体回退到 zh-CN 并带标记。

#### 2.2 Schema 与类型

- 04 §3.3 的 YAML 增加 `$defs.l10n`（`{ zh-CN, ja?, en? }`，值非空、不许其他键）与 `$defs.text`，文本字段改为 `anyOf`；
  `platform/shared/src/lab/lab-schema.generated.ts` 由 `node platform/shared/scripts/gen-lab-schema.mjs` 从文档重新生成
  （`lab-schema.test.ts` 仍逐字比较）。其他 schema 用 `scripts/labs/src/schemas/l10n.ts` 的 `l10n()` 包装；`npm run labs:schema`
  重写 `labs/_schema/*.json`。
- 长度限制只约束 zh-CN：lint 先把文档解析成 zh-CN 再校验；`anyOf` 两个分支的报错只保留与值的形态相符的一支。
- TypeScript：`LabV2<S = string>` 的文本字段是 `S`；`LabV2`（解析后，构建产物与 API 读的就是它）不变，`LabV2Source =
  LabV2<LocalizedText>` 是写在 lab.yaml 里的形态。`@atl/shared` 的 `l10n.ts`：`ContentLang`、`resolveText`、`resolveLocalized`
  （回退指针回调、标记）、`collectLocalized`、`negotiateLang`、`normalizeLang`。
- 哪些字段是文本不另列清单：`scripts/labs/src/l10n.ts` 的 `textPatterns()` 从 schema 中找出带 `$defs/l10n` 分支的位置。

#### 2.3 `labs:lint` 的翻译规则与覆盖率

内容集按语言加载（`loadContent(paths, { lang })`），每份文档解析成该语言的字符串，原文保留在 `source`，因此原有的 lint、
目录与构建逻辑不变。新增规则（`scripts/labs/src/lint/i18n.ts`）：

| 规则 | 级别 | 内容 |
|---|---|---|
| I1 | error | 本地化对象中有空字符串（不翻译就不写该语言） |
| I2 | error | 本地化对象写在了非文本字段（id、枚举、命令、标签…） |
| I3 | error | `manual/<lang>/x.md` 没有对应的 zh-CN 文件、同一文件写了两份、front matter 的 step / section 与原文不同 |
| I4 | warn | 译文改变了 `{{ … }}` 变量、指令或代码块数量 |
| I5 | warn | 译后的 00-overview.md 缺少原文已有标题的译名（C-12 / 简介页按标题找章节） |

`npm run labs:i18n`：每张卡片（以及 `_shared`、`_tracks`、`_catalog`）的文本字段数与 ja / en 已译比例、手册文件数与已译比例，
附 I1～I5；`--json` 可读。2026-10-14：4281 个文本字段、231 个手册文件，ja / en 均 0%。
`npm run labs:catalog -- --lang ja [--out f]` 打印按语言解析的目录（提交到仓库的 catalog.yaml 仍是 zh-CN）。

#### 2.4 构建产物与前端读取

`labs:build` 的根目录不变（zh-CN 源文档，字节级与以前相同），另外生成：

| 路径 | 内容 |
|---|---|
| `content/<v>/<lang>/catalog/index.json` | 目录索引；每张卡片、每条路径带自己的 `i18n`，索引本身的 `i18n` 列出 taxonomy 等处的回退 |
| `content/<v>/<lang>/catalog/cards/<id>.json` | 简介；概览手册不是该语言时含 `/overview` |
| `content/<v>/<lang>/labs/<id>.json` | 展开后的卡片；`manuals[file].lang` 是该手册实际的语言 |
| `content/<v>/<lang>/tracks/<id>.json` | 学习路径 |
| `private/quiz/<lang>/<id>.json` | 小测题库（只进 atl-artifacts） |
| `manifest.json` | 增加 `languages: [zh-CN, ja, en]` |

`<lang>` 为 ja、en。每份按语言生成的文档带 `i18n: { lang, fallback: [JSON 指针…] }`，指针相对于带 `i18n` 的对象，列出显示了
其他语言的字段。计算方法：同一语言渲染两遍，第二遍把回退的值加上不可见前缀，比较两份输出的差异——因此派生字段（搜索文本、
拼接的标题）也能正确标出，构建代码不需要知道哪些字段来自哪里。

前端（`i18n/content.ts`）：`contentUrl()` 把 `/content/<v>/<rel>` 改写成当前语言的地址（zh-CN 用根路径）；`fetchContentJson()`
在所选语言的文件 404（旧的内容版本）时读根路径并把整份文档标为未翻译（`i18n.whole`）；`untranslated(doc, pointer)`、
`manualUntranslated(manual)` 决定是否显示标记。目录（`pages/labs/data.ts`）、会话（`pages/sessions/data.ts`）与工作台
（`workspace/model/lab.ts`）的内容读取都经过它们，缓存键是改写后的地址，切换语言后自然重新读取。

#### 2.5 API 与开发服务器

- 语言协商（`@atl/shared` `negotiateLang`）：`?lang=` 优先，其次 `Accept-Language`（按 q 值；`ja-*` → ja、`en-*` → en、
  `zh`、`zh-CN`、`zh-Hans*`、`zh-SG` → zh-CN），都没有时 zh-CN。`platform/api/src/routes/catalog.ts` 的 `contentLang(ctx)`。
- `GET /catalog`：发布包有该语言（manifest `languages`）时，`indexUrl` / `cardIntroUrlTemplate` / `labUrlTemplate` 指向
  `/content/<v>/<lang>/…`，并返回 `contentLang`、`languages`；ETag 为 `"<v>-<lang>"`（zh-CN 仍是 `"<v>"`）。
- `GET /tracks`、`/tracks/{id}`：读该语言的目录索引，没有时读根索引。
- 小测：抽题与解析读 `private/quiz/<lang>/`（没有时读根题库），开始作答的响应带 `i18n: { lang, untranslated: [题目 id] }`；
  判分只按题目与选项 id，与语言无关。
- 会话、报价、检查、摘要校验一律读根目录的 zh-CN 文档（`CatalogStore.lab()`），语言只影响显示的文字。
- `PATCH /me` 的 `locale` 接受 `zh-CN | ja | en`。
- 开发服务器 `/content/`：`/content/<v>/<lang>/…` 按发布的文件提供（不存在时 404，由前端回退）；根路径的 JSON 带 `?lang=` 或
  `Accept-Language`（ja / en）时返回译后文档，没有时返回根文档，并设 `Content-Language` 与 `Vary: Accept-Language`。
  没有 `labs:build` 产物时的种子目录（`seedDevCatalog`）把本地化对象解析成 zh-CN。

### 3 与指示的差异、待办与需要配合

- **个人资料中的语言只写不读**：I1 要求“有偏好 API 就同步”。服务器上的 `locale` 默认仍是 zh-CN（`users.ts` 的建档默认值、
  `/me` 的回退值不属于本次范围），若回读会把第一次访问的日语改掉，所以 localStorage 是唯一依据，服务器值只供将来的邮件等使用。
- **界面文案的回退不加标记**（§1.6），只有内容加标记。
- **译文本身**：ja / en 词典各 3467 个键、内容 4281 个文本字段与 231 个手册文件待翻译（翻译者按 §1.9、§2.1）。
- **服务器端生成的报告 / 分享 HTML**（`platform/api/src/services/reports/html.ts`）与 API 错误的 `detail` 仍为中文。
- **CloudAlbum 前端（`frontend/`）** 不在本轮（I5）。
- **e2e** 显式选择 zh-CN（§1.7）；按 ja / en 的端到端检查需在译文就绪后补充。
- 按语言生成的 `labs/<id>.json` 中 `checkHashes` 按译后的检查定义计算；执行与校验只用根目录文档，不受影响。

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
