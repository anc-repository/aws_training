/**
 * 工作台的数据（08 P04、P05.11 数据来源表；§7.4 事件到界面的映射）：
 *
 * | 数据 | 接口 | 刷新 |
 * |---|---|---|
 * | 手册 | `/content/<catalogVersion>/labs/<labId>.json` | 进入（版本由会话固定） |
 * | 变量 | `GET /sessions/{sid}/vars` | 进入；`module_op.succeeded`、`check_run.completed` 后；实验机替换后 |
 * | 步骤与进度 | `GET /sessions/{sid}/steps`、`/progress`（ETag） | 事件驱动（step.*、attempt.*、check_run.*、manual_confirmation.*） |
 * | 工作台描述 | `GET /sessions/{sid}/workspace` | 进入、重新可见、`env.*` / `module_op.*` 事件后、每 60 秒（准备阶段 provision.ssm 之后 15 秒） |
 * | 实验记录 | `GET /sessions/{sid}/experiment-runs` | 进入；`experiment_run.*` |
 * | 费用 | `GET /sessions/{sid}/cost`（L A） | 每 5 分钟；`resource.discovered`、`module_op.succeeded` 后 |
 * | 平台动作 | `GET /sessions/{sid}/module-ops` | 事件 `module_op.*` |
 *
 * 会话视图与事件由 SessionSync 统一维护，这里只订阅。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { SessionEvent, SessionView } from '../../api/types';
import { useServices, useSessionEvents } from '../../app/context';
import { catalogIndexUrl, fetchContent, labContentUrl, type LabDoc } from '../model/lab';
import type { VarsResponse } from '../model/vars';
import { useResource } from './resource';
import type { ExperimentRunsResponse, ModuleOpView, ProgressResponse, SessionCostView, StepsResponse, WorkspaceView } from './types';
import type { StepResultView } from '../model/checks';

export interface CatalogIndexLite {
  taxonomy?: { categories?: { id: string; token?: string }[]; services?: { id: string; abbr?: string; short?: string; category?: string }[] };
  cards?: { id: string; costTier?: { required?: string }; provisionClass?: string }[];
}

export interface WorkspaceData {
  lab: ReturnType<typeof useResource<LabDoc>>;
  index: ReturnType<typeof useResource<CatalogIndexLite>>;
  vars: ReturnType<typeof useResource<VarsResponse>>;
  steps: ReturnType<typeof useResource<StepsResponse>>;
  stepMap: ReadonlyMap<string, StepResultView>;
  progress: ReturnType<typeof useResource<ProgressResponse>>;
  workspace: ReturnType<typeof useResource<WorkspaceView>>;
  experiments: ReturnType<typeof useResource<ExperimentRunsResponse>>;
  cost: ReturnType<typeof useResource<SessionCostView>>;
  moduleOps: ReturnType<typeof useResource<{ items: ModuleOpView[] }>>;
  /** 最近事件（本会话，新的在后）。 */
  events: readonly SessionEvent[];
  /** `check_run.completed` 到达时递增（步骤检测面板据此刷新本步的检测历史）。 */
  checkRunTick: number;
  lastCheckRun: SessionEvent | null;
}

const PROGRESS_EVENTS = ['step.state_changed', 'step.drifted', 'attempt.state_changed', 'check_run.completed', 'manual_confirmation.submitted', 'manual_confirmation.reviewed', 'badge.earned', 'badge.withdrawn'];

export function useWorkspaceData(sid: string, view: SessionView | null, opts: { role: 'L' | 'A' | 'O' | null; catalogVersion: string | null }): WorkspaceData {
  const { api, sync } = useServices();
  const labKey = view && opts.catalogVersion ? labContentUrl(opts.catalogVersion, view.labId) : null;
  const lab = useResource<LabDoc>(labKey, () => fetchContent<LabDoc>(labKey!));
  const idxKey = opts.catalogVersion ? catalogIndexUrl(opts.catalogVersion) : null;
  const index = useResource<CatalogIndexLite>(idxKey, () => fetchContent<CatalogIndexLite>(idxKey!).catch(() => null));

  const ready = !!view;
  const preparing = view ? view.state === 'REQUESTED' || view.state === 'PROVISIONING' : false;
  const live = view ? ['READY', 'RUNNING', 'EXPIRING'].includes(view.state) : false;
  const vars = useResource<VarsResponse>(ready ? `vars:${sid}` : null, () => api.get<VarsResponse>('getVars', { params: { sid } }));
  const steps = useResource<StepsResponse>(ready && !preparing ? `steps:${sid}` : null, () => api.get<StepsResponse>('listSteps', { params: { sid } }));
  const progress = useResource<ProgressResponse>(ready && !preparing ? `progress:${sid}` : null, () => api.get<ProgressResponse>('getSessionProgress', { params: { sid } }));
  const sawSsmPhase = (view?.phases ?? []).some((p) => p.name.startsWith('provision.ssm') || p.name.startsWith('provision.wire') || p.name.startsWith('provision.health'));
  const workspace = useResource<WorkspaceView>(ready ? `ws:${sid}` : null, () => api.get<WorkspaceView>('getWorkspace', { params: { sid } }), {
    intervalMs: preparing ? (sawSsmPhase ? 15_000 : null) : live ? 60_000 : null,
  });
  const experiments = useResource<ExperimentRunsResponse>(ready && !preparing ? `exp:${sid}` : null, () => api.get<ExperimentRunsResponse>('listSessionExperimentRuns', { params: { sid } }));
  const costAllowed = opts.role === 'L' || opts.role === 'A';
  const cost = useResource<SessionCostView>(ready && costAllowed && (live || preparing) ? `cost:${sid}` : null, () => api.get<SessionCostView>('getSessionCost', { params: { sid } }), {
    intervalMs: 5 * 60_000,
  });
  const moduleOps = useResource<{ items: ModuleOpView[] }>(ready && live ? `ops:${sid}` : null, () => api.get<{ items: ModuleOpView[] }>('listModuleOps', { params: { sid } }));

  const [events, setEvents] = useState<readonly SessionEvent[]>(() => sync.recentEvents(sid));
  const [checkRunTick, setTick] = useState(0);
  const lastCheck = useRef<SessionEvent | null>(null);

  const refs = useRef({ vars, steps, progress, workspace, experiments, cost, moduleOps });
  refs.current = { vars, steps, progress, workspace, experiments, cost, moduleOps };

  const onEvents = useCallback(
    (eventSid: string, evs: readonly SessionEvent[]) => {
      if (eventSid !== sid) return;
      setEvents(sync.recentEvents(sid));
      const r = refs.current;
      const types = new Set(evs.map((e) => e.type));
      const has = (...t: string[]) => t.some((x) => types.has(x));
      if (evs.some((e) => PROGRESS_EVENTS.includes(e.type))) {
        void r.steps.refresh();
        void r.progress.refresh();
      }
      if (has('check_run.completed')) {
        lastCheck.current = [...evs].reverse().find((e) => e.type === 'check_run.completed') ?? null;
        setTick((x) => x + 1);
        void r.vars.refresh();
      }
      if (has('module_op.succeeded')) {
        void r.vars.refresh();
        void r.cost.refresh();
      }
      if (has('module_op.started', 'module_op.succeeded', 'module_op.failed')) void r.moduleOps.refresh();
      if (has('env.degraded', 'env.recovered', 'module_op.succeeded', 'module_op.failed', 'session.outage_window_changed', 'session.access_revoked', 'session.state_changed', 'console_link.issued', 'terminal.opened', 'terminal.closed'))
        void r.workspace.refresh();
      if (evs.some((e) => e.type.startsWith('experiment_run.'))) void r.experiments.refresh();
      if (has('resource.discovered')) void r.cost.refresh();
      if (has('session.state_changed')) {
        void r.vars.refresh();
        void r.steps.refresh();
        void r.progress.refresh();
      }
    },
    [sid, sync],
  );
  useSessionEvents(onEvents, { sid });

  const stepMap = useMemo(() => new Map((steps.data?.items ?? []).map((s) => [s.stepId, s])), [steps.data]);

  return { lab, index, vars, steps, stepMap, progress, workspace, experiments, cost, moduleOps, events, checkRunTick, lastCheckRun: lastCheck.current };
}
