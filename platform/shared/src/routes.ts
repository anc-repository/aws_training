/**
 * The only route table of `/api/v1` — 01 §8.2 (transcribed), with the auth column of §8.1 / §5.3.
 *
 * `rbac.ts` in `atl-api` is derived from `auth`; the dev server and the API router dispatch on `id`.
 * Routes requested by 08 §9.2 and implemented by definition of 08 while 01 has not registered them carry `pending01`
 * (the 01 §8.2 transcription test excludes them); the rest of the 08 requests are listed in `UI_REQUESTED_ROUTES` and
 * are NOT part of `ROUTES`.
 */

export const API_PREFIX = '/api/v1';

/** `L` learner, `A` assistant, `O` observer (Cognito groups); `WS` SigV4 `ATLLearnerRole/atl-<sid>-ws`; `RUN` SigV4 `ATLProvisionerRole/atl-<sid>-prov-*`; `PUBLIC` none. */
export type RouteAuth = 'L' | 'A' | 'O' | 'WS' | 'RUN' | 'PUBLIC' | 'RUN_TOKEN';
/** API Gateway route family (01 §5.3). */
export type RouteKind = 'jwt' | 'agent' | 'internal' | 'public' | 'agent-fallback';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Lambda that serves the route family. */
export type RouteFunction = 'atl-api' | 'atl-agent' | 'atl-public';

export interface RouteDef {
  id: string;
  method: HttpMethod;
  /** Path below `/api/v1`, parameters as `{name}`. */
  path: string;
  auth: readonly RouteAuth[];
  summary: string;
  /** Defining document (01 §8.2 “定义” column). */
  doc: string;
  /** Returns 202 Accepted (long operation). */
  async?: boolean;
  /** Sensitive operation: requires a real login (`auth_time`) within 60 minutes (01 §5.3). */
  recentAuth?: boolean;
  /** Requested by 08 §9.2 and implemented by its definition; not registered in 01 §8.2 yet (the 08 item). */
  pending01?: string;
}

export interface ResolvedRouteDef extends RouteDef {
  kind: RouteKind;
  fn: RouteFunction;
  /** `Idempotency-Key` header required (all POST and `PUT …/result`, 01 §7.5 item 3). */
  idempotent: boolean;
}

const LAO = ['L', 'A', 'O'] as const;
const LA = ['L', 'A'] as const;
const L = ['L'] as const;
const A = ['A'] as const;
const WS = ['WS'] as const;
const RUN = ['RUN'] as const;
const PUB = ['PUBLIC'] as const;

const RAW_ROUTES = [
  // 平台与个人
  { id: 'getMe', method: 'GET', path: '/me', auth: LAO, summary: '当前用户、组、显示名、通知偏好、currentTrackId', doc: '01' },
  { id: 'patchMe', method: 'PATCH', path: '/me', auth: LAO, summary: '修改显示名、证书署名、语言、通知偏好、当前学习路径', doc: '01' },
  { id: 'getMyProgress', method: 'GET', path: '/me/progress', auth: LAO, summary: '全部 LabProgress（含徽章）与学习路径进度', doc: '04、tracks' },
  { id: 'getMyMastery', method: 'GET', path: '/me/mastery', auth: LAO, summary: '掌握度与服务地图（按需计算，不落库）', doc: 'tracks §5.7' },
  { id: 'getTime', method: 'GET', path: '/time', auth: LAO, summary: '对时：serverNow', doc: '02 §5.5' },
  { id: 'getPlatform', method: 'GET', path: '/platform', auth: LAO, summary: '版本、区域、限额、维护模式、体检结果、可用更新', doc: '01' },
  { id: 'getGuardrails', method: 'GET', path: '/platform/guardrails', auth: LAO, summary: '预算状态、各类上限、卸载状态', doc: '02 §10' },
  { id: 'setMaintenance', method: 'POST', path: '/platform/maintenance', auth: L, summary: '{ on } 进入 / 退出维护模式', doc: '01' },
  { id: 'prepareUninstall', method: 'POST', path: '/platform/uninstall/prepare', auth: L, summary: '进入 UNINSTALLING，启动 atl-platform-uninstall', doc: '4.8、02 §10.5', async: true, recentAuth: true },
  { id: 'getUninstallStatus', method: 'GET', path: '/platform/uninstall/status', auth: L, summary: '卸载阻塞项与 ready', doc: '4.8' },
  { id: 'createExport', method: 'POST', path: '/platform/exports', auth: L, summary: '生成学习档案 zip，完成后返回预签名下载链接', doc: '4.8、04', async: true },
  { id: 'getSettings', method: 'GET', path: '/settings', auth: L, summary: '平台设置', doc: '01、03' },
  { id: 'patchSettings', method: 'PATCH', path: '/settings', auth: L, summary: '修改平台设置（不超过安装参数上限）', doc: '01、03' },
  { id: 'listMembers', method: 'GET', path: '/members', auth: L, summary: '成员列表', doc: '01' },
  { id: 'inviteMember', method: 'POST', path: '/members', auth: L, summary: '邀请助教 / 观察者 { email, role }', doc: '01' },
  { id: 'deleteMember', method: 'DELETE', path: '/members/{sub}', auth: L, summary: '删除成员', doc: '01' },
  { id: 'listAuditEvents', method: 'GET', path: '/audit-events', auth: LA, summary: '审计事件（?sessionId=&from=&to=）', doc: '01' },

  // 目录、学习路径与报价
  { id: 'getCatalog', method: 'GET', path: '/catalog', auth: LAO, summary: '当前目录版本、内容基址、catalog.yaml 摘要', doc: '05、tracks' },
  { id: 'listLabs', method: 'GET', path: '/labs', auth: LAO, summary: '卡片列表 + 我的进度与徽章', doc: '05' },
  { id: 'getLab', method: 'GET', path: '/labs/{labId}', auth: LAO, summary: '卡片概览：类型、变体、起始状态、目标模块、计费维度、reuseFrom', doc: '05' },
  { id: 'createLabQuote', method: 'POST', path: '/labs/{labId}/quotes', auth: L, summary: '开始前报价 { purpose: START|REUSE, variant?, reuseEnvironmentId? } → CostQuote', doc: '02 §3.2' },
  { id: 'listTracks', method: 'GET', path: '/tracks', auth: LAO, summary: '学习路径定义与进度', doc: 'tracks' },
  { id: 'getTrack', method: 'GET', path: '/tracks/{trackId}', auth: LAO, summary: '学习路径定义与进度', doc: 'tracks' },
  { id: 'markReleaseDefective', method: 'POST', path: '/catalog/releases/{catalogVersion}/defective', auth: L, summary: '把内容版本标记为有缺陷', doc: '04 §10.7' },

  // 会话生命周期与环境
  { id: 'createSession', method: 'POST', path: '/sessions', auth: L, summary: '开始实验 { labId, quoteId, costAcknowledged, variant?, trackId?, reuseEnvironmentId?, residualAck?, learnerInputs?, workstation? }', doc: '02 §3.3', async: true },
  { id: 'listSessions', method: 'GET', path: '/sessions', auth: LAO, summary: '我的会话列表（?state=&labId=）', doc: '01' },
  { id: 'getCurrentSession', method: 'GET', path: '/sessions/current', auth: LAO, summary: '当前非终态会话（含 KEPT），没有则 204', doc: '02' },
  { id: 'getSession', method: 'GET', path: '/sessions/{sid}', auth: LAO, summary: '会话视图', doc: '02 §13.1' },
  { id: 'listSessionEvents', method: 'GET', path: '/sessions/{sid}/events', auth: LAO, summary: '事件增量（?after=，轮询）', doc: '01' },
  { id: 'heartbeat', method: 'POST', path: '/sessions/{sid}/heartbeat', auth: L, summary: '心跳与对时 { workbench? } → serverNow、deadlineAt、deadlineVersion', doc: '02 §5.6' },
  { id: 'createSessionQuote', method: 'POST', path: '/sessions/{sid}/quotes', auth: L, summary: '延长或保留的报价 { purpose: EXTEND|KEEP, minutes?, keepHours? }', doc: '02 §5.4、§8.1' },
  { id: 'extendSession', method: 'POST', path: '/sessions/{sid}/extend', auth: L, summary: '{ minutes, quoteId, expectedDeadlineVersion }（atl-lifecycle Extend）', doc: '02 §5.4' },
  { id: 'endSession', method: 'POST', path: '/sessions/{sid}/end', auth: L, summary: '结束 / 取消 / 预选到期处置 { disposition, keepHours?, quoteId?, when, keepPrerequisites? }', doc: '02 §6.1', async: true },
  { id: 'extendKeep', method: 'POST', path: '/sessions/{sid}/keep/extend', auth: L, summary: '延长保留 { hours, quoteId }', doc: '02 §8' },
  { id: 'releaseKeep', method: 'POST', path: '/sessions/{sid}/keep/release', auth: L, summary: '立即释放保留的环境', doc: '02 §8.3', async: true },
  { id: 'getCleanup', method: 'GET', path: '/sessions/{sid}/cleanup', auth: LA, summary: '回收报告与待人工处理清单（?format=json|md）', doc: '02 §7.9' },
  { id: 'retryCleanup', method: 'POST', path: '/sessions/{sid}/cleanup/retry', auth: L, summary: '对 CLEANUP_FAILED 会话重试回收（T19）', doc: '02' },
  { id: 'resolveCleanupItem', method: 'POST', path: '/sessions/{sid}/cleanup/items/{resourceKey}/resolve', auth: L, summary: '标记已人工处理，触发 atl-reaper 复核', doc: '02 §7.8' },
  { id: 'listSessionResources', method: 'GET', path: '/sessions/{sid}/resources', auth: LA, summary: '本会话创建的资源（SESRES#<sid>，?state=）', doc: '01' },
  { id: 'listManualResources', method: 'GET', path: '/resources/manual', auth: LA, summary: '全部环境的待人工处理清单', doc: '01' },
  { id: 'getSessionCost', method: 'GET', path: '/sessions/{sid}/cost', auth: LA, summary: '运行中的计费资源与估算（只给维度与估算值）', doc: '01、02 §10.2' },
  { id: 'getCurrentEnvironment', method: 'GET', path: '/environments/current', auth: LAO, summary: '当前环境（含 KEPT）：模块、入口、每小时估算、keepUntil', doc: '02' },
  { id: 'repairEnvironment', method: 'POST', path: '/environments/{envId}/repair', auth: L, summary: '环境修复（运行器 repair）', doc: '02 §12', async: true },

  // 工作台
  { id: 'getWorkspace', method: 'GET', path: '/sessions/{sid}/workspace', auth: LAO, summary: '工作台描述（可用标签、终端目标、预览入口）', doc: '03 §2.7' },
  { id: 'postWorkspaceEvents', method: 'POST', path: '/sessions/{sid}/workspace-events', auth: L, summary: '工作台事件上报（workspace.*）', doc: '03 §7.4' },
  { id: 'listTerminals', method: 'GET', path: '/sessions/{sid}/terminals', auth: L, summary: '列出终端', doc: '03' },
  { id: 'createTerminal', method: 'POST', path: '/sessions/{sid}/terminals', auth: L, summary: '{ target: lab|workstation, instanceId? } → StreamUrl、TokenValue', doc: '03 §3.2', recentAuth: true },
  { id: 'resumeTerminal', method: 'POST', path: '/sessions/{sid}/terminals/{terminalId}/resume', auth: L, summary: '续连', doc: '03', recentAuth: true },
  { id: 'deleteTerminal', method: 'DELETE', path: '/sessions/{sid}/terminals/{terminalId}', auth: L, summary: '结束 SSM 会话', doc: '03' },
  { id: 'createConsoleLink', method: 'POST', path: '/sessions/{sid}/console-link', auth: L, summary: '{ destination? | linkId? } → 联合登录表单与 consoleSessionExpiresAt', doc: '03 §5', recentAuth: true },
  { id: 'getPreview', method: 'GET', path: '/sessions/{sid}/preview', auth: LAO, summary: '预览入口 targets[]、是否可嵌入及原因码', doc: '03 §6.1' },
  { id: 'getAppCredentials', method: 'GET', path: '/sessions/{sid}/app-credentials', auth: L, summary: 'CloudAlbum 管理员账号与初始密码（no-store，记审计）', doc: '01', recentAuth: true },

  // 步骤、检测与平台动作
  { id: 'listSteps', method: 'GET', path: '/sessions/{sid}/steps', auth: LAO, summary: '全部 StepResult', doc: '04' },
  { id: 'getSessionProgress', method: 'GET', path: '/sessions/{sid}/progress', auth: LAO, summary: '进度汇总（带 ETag）', doc: '04' },
  { id: 'getVars', method: 'GET', path: '/sessions/{sid}/vars', auth: LAO, summary: '已解析变量（敏感值打码）', doc: '04' },
  { id: 'putVar', method: 'PUT', path: '/sessions/{sid}/vars/{name}', auth: L, summary: '填写 input 变量', doc: '04' },
  { id: 'createStepCheckRun', method: 'POST', path: '/sessions/{sid}/steps/{stepId}/check-runs', auth: LA, summary: '运行本步检查（checkIds?、force?）→ runId', doc: '04', async: true },
  { id: 'createCheckRun', method: 'POST', path: '/sessions/{sid}/check-runs', auth: LA, summary: '跨步骤检查（scope: lab|final-preview）', doc: '04', async: true },
  { id: 'listCheckRuns', method: 'GET', path: '/sessions/{sid}/check-runs', auth: LAO, summary: '检测历史（?stepId=）', doc: '04' },
  { id: 'getCheckRun', method: 'GET', path: '/sessions/{sid}/check-runs/{runId}', auth: LAO, summary: '单次检测结果', doc: '04' },
  { id: 'createManualConfirmation', method: 'POST', path: '/sessions/{sid}/steps/{stepId}/manual-confirmations', auth: L, summary: '手动确认 { checkId, observed, note, evidence? }', doc: '04' },
  { id: 'reviewManualConfirmation', method: 'POST', path: '/sessions/{sid}/manual-confirmations/{confirmationId}/review', auth: A, summary: '复核 { decision: approve|reject, comment }', doc: '04' },
  { id: 'markStepRead', method: 'POST', path: '/sessions/{sid}/steps/{stepId}/read', auth: L, summary: '阅读型步骤标记已读', doc: '04' },
  { id: 'ackDrift', method: 'POST', path: '/sessions/{sid}/steps/{stepId}/drift-ack', auth: L, summary: '确认“有意改动”', doc: '04 §5.8' },
  { id: 'skipStep', method: 'POST', path: '/sessions/{sid}/steps/{stepId}/skip', auth: L, summary: '跳过选做步骤', doc: '04' },
  { id: 'unskipStep', method: 'DELETE', path: '/sessions/{sid}/steps/{stepId}/skip', auth: L, summary: '撤销跳过', doc: '04' },
  { id: 'submitSession', method: 'POST', path: '/sessions/{sid}/submit', auth: L, summary: '提交实验（最终复核）', doc: '04 §8.5' },
  { id: 'requestModuleOp', method: 'POST', path: '/sessions/{sid}/module-ops', auth: L, summary: '平台动作 { actionId }（只接受卡片 platformOps[] 中的 actionId，含 xstk-<stackId>）', doc: '04 §3、9.6', async: true, recentAuth: true },
  { id: 'listModuleOps', method: 'GET', path: '/sessions/{sid}/module-ops', auth: LAO, summary: '平台动作与工作台、运行器上报的模块操作', doc: '01' },

  // 对比实验
  { id: 'listSessionExperimentRuns', method: 'GET', path: '/sessions/{sid}/experiment-runs', auth: LAO, summary: '本会话的实验记录', doc: '04' },
  { id: 'listExperimentRuns', method: 'GET', path: '/experiment-runs', auth: LAO, summary: '跨会话（?module=&experiment=）', doc: '04' },
  { id: 'compareExperimentRuns', method: 'GET', path: '/experiment-runs/compare', auth: LAO, summary: '两次运行并排对比（?a=&b=）', doc: '04' },
  { id: 'getExperimentRun', method: 'GET', path: '/experiment-runs/{runId}', auth: LAO, summary: '详情（含完整结果的下载链接）', doc: '04' },

  // 小测、报告、分享与证书
  { id: 'startQuizAttempt', method: 'POST', path: '/labs/{labId}/quiz-attempts', auth: L, summary: '开始一次小测（服务端抽题，答案不下发）', doc: '04' },
  { id: 'saveQuizAnswers', method: 'PUT', path: '/quiz-attempts/{attemptId}/answers', auth: L, summary: '保存作答', doc: '04' },
  { id: 'submitQuizAttempt', method: 'POST', path: '/quiz-attempts/{attemptId}/submit', auth: L, summary: '交卷，服务端判分', doc: '04、tracks §5.2' },
  { id: 'generateReport', method: 'POST', path: '/sessions/{sid}/report', auth: L, summary: '生成或重新生成报告', doc: '04', async: true },
  { id: 'getReport', method: 'GET', path: '/sessions/{sid}/report', auth: LAO, summary: '报告摘要与 HTML/JSON 下载链接', doc: '04' },
  { id: 'exportReport', method: 'GET', path: '/sessions/{sid}/report/export', auth: L, summary: '导出（?format=json|html&mask=…，预签名下载链接）', doc: '04' },
  { id: 'createReportShare', method: 'POST', path: '/sessions/{sid}/report/shares', auth: L, summary: '创建分享链接', doc: '04 §9.5' },
  { id: 'listReportShares', method: 'GET', path: '/sessions/{sid}/report/shares', auth: L, summary: '分享链接列表', doc: '04 §9.5' },
  { id: 'deleteReportShare', method: 'DELETE', path: '/sessions/{sid}/report/shares/{shareId}', auth: L, summary: '撤销分享链接', doc: '04 §9.5' },
  { id: 'listReports', method: 'GET', path: '/reports', auth: LAO, summary: '我的报告（?labId=）', doc: '04' },
  { id: 'issueCertificate', method: 'POST', path: '/certificates', auth: L, summary: '领取证书 { scope: track, trackId }', doc: '04 §10、tracks §5.5', recentAuth: true },
  { id: 'listCertificates', method: 'GET', path: '/certificates', auth: LAO, summary: '我的证书', doc: '04' },
  { id: 'getCertificate', method: 'GET', path: '/certificates/{certId}', auth: LAO, summary: '证书详情（JWS）', doc: '04' },
  { id: 'patchCertificate', method: 'PATCH', path: '/certificates/{certId}', auth: L, summary: '公开 / 取消公开证书文件', doc: '04' },
  { id: 'getOfflineBundle', method: 'GET', path: '/certificates/{certId}/offline-bundle', auth: L, summary: '离线验证包', doc: '04' },
  { id: 'revokeCertificate', method: 'POST', path: '/certificates/{certId}/revoke', auth: L, summary: '撤销 { reason }', doc: '04' },

  // Agent（工作台，SigV4）
  { id: 'agentGetContext', method: 'GET', path: '/agent/sessions/{sid}/context', auth: WS, summary: '会话上下文 atl.agent-context/v1（PROVISIONING 时也可调用）', doc: '01 §8.2、03 §4.6、04 §7.2、06 PM-26' },
  { id: 'agentRegisterExperimentRun', method: 'POST', path: '/agent/sessions/{sid}/experiment-runs', auth: WS, summary: '登记实验运行 → runId', doc: '04 §7.1' },
  { id: 'agentPutExperimentResult', method: 'PUT', path: '/agent/sessions/{sid}/experiment-runs/{runId}/result', auth: WS, summary: '上传结果（result.schema.json）', doc: '04 §7.2' },
  { id: 'agentGetExperimentRun', method: 'GET', path: '/agent/sessions/{sid}/experiment-runs/{runId}', auth: WS, summary: '运行器轮询交叉校验结论', doc: '04' },
  { id: 'agentCreateAttachment', method: 'POST', path: '/agent/sessions/{sid}/experiment-runs/{runId}/attachments', auth: WS, summary: '申请附件的预签名 PUT', doc: '04' },
  { id: 'agentReportModuleOp', method: 'POST', path: '/agent/sessions/{sid}/module-ops', auth: WS, summary: '工作台 scripts/module 上报操作开始与结束', doc: '9.6' },

  // Internal（运行器，SigV4）
  { id: 'internalRunEvents', method: 'POST', path: '/internal/runs/{runId}/events', auth: RUN, summary: '运行器进度行 → session.progress 事件', doc: '02 §4.3' },
  { id: 'internalCredentialGrant', method: 'POST', path: '/internal/runs/{runId}/credential-grant', auth: RUN, summary: '运行器登记自己的会话名（CredentialGrant prov-<op>）', doc: '02 §4.3' },
  { id: 'internalReportModuleOp', method: 'POST', path: '/internal/sessions/{sid}/module-ops', auth: RUN, summary: '运行器执行的模块操作开始与结束', doc: '9.6' },

  // 回退路由（默认关闭）
  { id: 'agentFallbackPutResult', method: 'PUT', path: '/agent-fallback/runs/{runId}/result', auth: ['RUN_TOKEN'], summary: '定稿上传回退（一次性 runToken，开关关闭时 404）', doc: '5.3' },

  // 公开
  { id: 'publicHealth', method: 'GET', path: '/public/health', auth: PUB, summary: '平台版本与健康状态', doc: '01' },
  { id: 'publicGetCertificate', method: 'GET', path: '/public/certificates/{certId}', auth: PUB, summary: '证书状态的便捷查询', doc: '01' },
  { id: 'publicListKeys', method: 'GET', path: '/public/keys', auth: PUB, summary: '公钥（PEM 与 JWK），含已停用的', doc: '01' },
  { id: 'publicGetKey', method: 'GET', path: '/public/keys/{kid}', auth: PUB, summary: '公钥（PEM 与 JWK）', doc: '01' },

  // 08 §9.2 请求、01 尚未登记的路由（按 08 的定义实现，待 01 §8.2 收录）
  { id: 'listRunnerRuns', method: 'GET', path: '/sessions/{sid}/runner-runs', auth: LAO, summary: '运行器构建记录（RunnerRun）列表', doc: '08 §9.2 #11', pending01: '08 §9.2 #11' },
  { id: 'getRunnerRunLog', method: 'GET', path: '/sessions/{sid}/runner-runs/{runId}/log', auth: LA, summary: '脱敏的进度与日志摘要（atl-data/runs/<runId>/）', doc: '08 §9.2 #11', pending01: '08 §9.2 #11' },
  { id: 'getCheckEvidence', method: 'GET', path: '/sessions/{sid}/check-runs/{runId}/evidence/{checkKey}', auth: LAO, summary: '同源读取大于 4 KB 的脱敏证据（atl-data/evidence/）', doc: '08 §9.2 #13', pending01: '08 §9.2 #13' },
  { id: 'getPlatformExport', method: 'GET', path: '/platform/exports/{exportId}', auth: L, summary: '学习档案导出的状态与下载链接', doc: '08 §9.2 #16', pending01: '08 §9.2 #16' },
  { id: 'listManualConfirmations', method: 'GET', path: '/manual-confirmations', auth: A, summary: '助教复核队列（?status=pending，AP20 REVIEW#PENDING）', doc: '08 §9.2 #18', pending01: '08 §9.2 #18' },
  { id: 'listEnvironmentResources', method: 'GET', path: '/environments/{envId}/resources', auth: LA, summary: '环境交接链的回收台账（?state=）', doc: '08 §9.2 #28', pending01: '08 §9.2 #28' },
  { id: 'openStepOutage', method: 'POST', path: '/sessions/{sid}/steps/{stepId}/outage', auth: L, summary: '打开步骤级预期中断窗口（atl-lifecycle OpenOutageWindow）', doc: '08 §9.2 #25', async: true, pending01: '08 §9.2 #25' },
] as const satisfies readonly RouteDef[];

function kindOf(path: string): RouteKind {
  if (path.startsWith('/agent-fallback/')) return 'agent-fallback';
  if (path.startsWith('/agent/')) return 'agent';
  if (path.startsWith('/internal/')) return 'internal';
  if (path.startsWith('/public/')) return 'public';
  return 'jwt';
}

const FN_OF_KIND: Readonly<Record<RouteKind, RouteFunction>> = {
  jwt: 'atl-api',
  agent: 'atl-agent',
  internal: 'atl-agent',
  'agent-fallback': 'atl-agent',
  public: 'atl-public',
};

export const ROUTES: readonly ResolvedRouteDef[] = (RAW_ROUTES as readonly RouteDef[]).map((r) => {
  const kind = kindOf(r.path);
  return {
    ...r,
    kind,
    fn: FN_OF_KIND[kind],
    idempotent: r.method === 'POST' || (r.method === 'PUT' && r.path.endsWith('/result')),
  };
});

export type RouteId = (typeof RAW_ROUTES)[number]['id'];

export const ROUTES_BY_ID: ReadonlyMap<string, ResolvedRouteDef> = new Map(ROUTES.map((r) => [r.id, r]));

export function routeById(id: string): ResolvedRouteDef {
  const r = ROUTES_BY_ID.get(id);
  if (!r) throw new Error(`unknown route id: ${id}`);
  return r;
}

/** Paths that implementations must not use any more (01 §8.2 “已废弃的路径”). */
export const DEPRECATED_PATHS = [
  'POST /labs/{labId}/estimate',
  'POST /cost-estimate',
  'GET /sessions/active',
  'POST /sessions/{sid}/keep',
  'POST /sessions/{sid}/resources/{resourceKey}/resolve',
  'GET /platform/uninstall-readiness',
  'POST /platform/prepare-uninstall',
] as const;

/**
 * Routes that 08 §9.2 asks 01 to register and that are not implemented yet (they need a decision of 01 or a dependency):
 * #5 the preflight's execution identity, #14 the Cost Explorer client, #29 the CloudShell bootstrap variables (03 §4.9).
 * Not part of ROUTES. Items 11, 13, 16, 18, 25 and 28 are in ROUTES with `pending01`.
 */
export const UI_REQUESTED_ROUTES = [
  { method: 'POST', path: '/platform/preflight', ref: '08 §9.2 #5' },
  { method: 'POST', path: '/sessions/{sid}/cost/actual', ref: '08 §9.2 #14' },
  { method: 'GET', path: '/sessions/{sid}/cloudshell-bootstrap', ref: '08 §9.2 #29' },
] as const;

// ---------------------------------------------------------------------------------------------------------------
// Matching

interface CompiledRoute {
  route: ResolvedRouteDef;
  segments: string[];
  staticCount: number;
}

const COMPILED: CompiledRoute[] = ROUTES.map((route) => {
  const segments = route.path.split('/').filter(Boolean);
  return { route, segments, staticCount: segments.filter((s) => !s.startsWith('{')).length };
});

export interface RouteMatch {
  route: ResolvedRouteDef;
  params: Record<string, string>;
}

/**
 * Match a request path (with or without the `/api/v1` prefix) — most specific route first (more static segments wins),
 * like HTTP API. Returns `null` when no route has this path; `{ route: null, allowed }` semantics are left to the caller
 * via `allowedMethods()`.
 */
export function matchRoute(method: string, rawPath: string): RouteMatch | null {
  const path = stripPrefix(rawPath);
  const parts = path.split('/').filter(Boolean);
  let best: { c: CompiledRoute; params: Record<string, string> } | null = null;
  for (const c of COMPILED) {
    if (c.route.method !== method.toUpperCase() || c.segments.length !== parts.length) continue;
    const params = matchSegments(c.segments, parts);
    if (params && (!best || c.staticCount > best.c.staticCount)) best = { c, params };
  }
  return best ? { route: best.c.route, params: best.params } : null;
}

/** Methods registered for a path (for 405 vs 404). */
export function allowedMethods(rawPath: string): HttpMethod[] {
  const parts = stripPrefix(rawPath).split('/').filter(Boolean);
  const out = new Set<HttpMethod>();
  for (const c of COMPILED) if (c.segments.length === parts.length && matchSegments(c.segments, parts)) out.add(c.route.method);
  return [...out];
}

function stripPrefix(p: string): string {
  const q = p.split('?')[0]!;
  return q.startsWith(API_PREFIX + '/') || q === API_PREFIX ? q.slice(API_PREFIX.length) || '/' : q;
}

function matchSegments(segments: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const p = parts[i]!;
    if (s.startsWith('{')) {
      let v: string;
      try {
        v = decodeURIComponent(p);
      } catch {
        return null;
      }
      params[s.slice(1, -1)] = v;
    } else if (s !== p) return null;
  }
  return params;
}
