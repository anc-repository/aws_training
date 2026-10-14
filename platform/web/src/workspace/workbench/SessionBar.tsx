/**
 * 工作台顶栏 SessionBar（08 P05.2、§5.3；03 §2.2、§2.3），高 48px：
 * 平台标志、“‹ 目录”（离开不需要确认）→ 卡片标识（[服务] / [场景] + 服务缩写方块，场景卡下方“本卡将依次启用：…”，有变体时附变体名）
 * → 状态胶囊 → 倒计时（剩余 + 绝对时间；准备阶段“已用 m:ss · 倒计时未开始”）→ 费用计（L A：≈ a～b/h · 已产生 ≈ x，点击打开明细；
 * O：只显示每小时估算）→ 延长（剩余次数；置灰时原因节点总是渲染）/ 结束实验…（准备阶段为“取消…”）→ 溢出菜单。
 * < 768px 折叠为“卡片 id · 状态 · 剩余时间 ⋯”，延长与结束收进 ⋯。
 */
import { Link } from 'react-router-dom';
import { getThemePref, setThemePref, type ThemePref } from '../../app/theme';
import { formatClock, formatCountdown } from '../../lib/format';
import { BrandMark, Countdown, Disclosure, Icon, SessionStatePill, displayState, useSecondTick } from '../../ui';
import { useWorkspace } from '../context';
import { accruedOf, formatRange, hourlyRangeOf } from '../model/cost';
import { EXTEND_REASON_TEXT, extendBlock } from '../model/expiry';
import type { CatalogIndexLite } from '../data/useWorkspaceData';

export interface SessionBarProps {
  onExtend: () => void;
  onEnd: () => void;
  onCancel: () => void;
  onCost: () => void;
  onShortcuts: () => void;
  onTermSettings: () => void;
  onCredentials: () => void;
}

const CAT_CLASS: Record<string, string> = { base: 'cat-base', A: 'cat-a', B: 'cat-b', C: 'cat-c', D: 'cat-d', E: 'cat-e', F: 'cat-f' };

function abbrOf(index: CatalogIndexLite | null, id: string): { abbr: string; cat: string } {
  const s = index?.taxonomy?.services?.find((x) => x.id === id);
  return { abbr: s?.abbr ?? s?.short ?? id.toUpperCase().slice(0, 4), cat: CAT_CLASS[s?.category ?? 'base'] ?? 'cat-base' };
}

function ElapsedClock({ since, now }: { since: string; now: () => number }) {
  useSecondTick(true);
  return <span className="mono">{formatCountdown(now() - Date.parse(since))}</span>;
}

export function SessionBar(p: SessionBarProps) {
  const ws = useWorkspace();
  // 每秒重算剩余时间（服务端时钟），只重绘顶栏
  useSecondTick(true);
  const v = ws.view;
  const lab = ws.data.lab.data;
  const index = ws.data.index.data;
  const remaining = v.deadlineAt ? Date.parse(v.deadlineAt) - ws.now() : null;
  const state = displayState(v.state, remaining);
  const primaryServices = (lab?.services ?? []).filter((s) => s.role === 'primary');
  const blocks = (primaryServices.length ? primaryServices : (lab?.services ?? []).slice(0, 1)).slice(0, 4);
  const hourly = hourlyRangeOf(v.env?.hourlyEstimate, ws.data.cost.data?.currency ?? 'USD', ws.data.cost.data?.priceAsOf ?? null) ?? hourlyRangeOf(ws.data.cost.data?.hourly ?? null);
  const accrued = accruedOf(ws.data.cost.data);
  const cur = hourly?.currency ?? ws.data.cost.data?.currency ?? 'USD';
  const left = v.limits?.extensionsLeft ?? 0;
  const used = Array.isArray(v.extensions) ? v.extensions.length : 0;
  const block = extendBlock(v, ws.allowed, { learner: ws.learner, uninstalling: ws.guard.uninstalling, budgetExceeded: ws.guard.budgetExceeded, nowMs: ws.now() });
  const canEnd = ws.allowed.includes('end');
  const canCancel = ws.allowed.includes('cancel');
  const preferred = (v as SessionViewExtra).preferredDisposition;
  const preferredKeep = (v as SessionViewExtra).preferredKeep;
  const reasonId = 'ws-extend-why';
  const targets = lab?.kind === 'scenario' ? (lab.targetModules ?? []).map((t) => t.id) : [];
  const doneModules = new Set((ws.data.progress.data?.steps ?? []).filter((s) => ['done', 'done_manual'].includes(s.state)).map((s) => lab?.targetModules?.find((t) => t.wireStep === s.stepId)?.id).filter(Boolean));
  return (
    <header className="wsbar" data-sessionbar="">
      <Link className="brand" to="/labs" title="ATL 实验平台（非 AWS 官方）">
        <BrandMark />
      </Link>
      <Link className="btn sm ghost" to="/labs">
        ‹ 目录
      </Link>
      <div className="ttl">
        {/* 每个画面一个 h1（08 §8.2）；工作台的可见标题是这一行，h1 只给读屏 */}
        <h1 className="sr" tabIndex={-1}>
          工作台 · {lab?.title ?? v.labId}
        </h1>
        <span className="tag">{lab?.kind === 'scenario' ? '场景' : '服务'}</span>
        {blocks.map((s) => {
          const a = abbrOf(index, s.id);
          return (
            <span key={s.id} className={`sv s20 ${a.cat}`} title={s.name ?? s.id} aria-hidden="true">
              {a.abbr}
            </span>
          );
        })}
        <span className="mono small">{v.labId}</span>
        <span className="t small muted wide-only">
          {lab?.title ?? ''}
          {v.variant && v.variant !== 'default' ? ` · 变体 ${v.variant}` : ''}
        </span>
      </div>
      <div className="clock">
        <SessionStatePill state={state} size="sm" />
        {ws.preparing ? (
          <span className="small">
            已用 <ElapsedClock since={v.createdAt} now={ws.now} /> · 倒计时未开始
          </span>
        ) : v.deadlineAt && ['READY', 'RUNNING', 'EXPIRING'].includes(v.state) ? (
          <>
            {v.state === 'READY' ? <span className="small muted wide-only">环境已就绪 · 剩余</span> : null}
            <Countdown deadlineAt={v.deadlineAt} now={ws.now} variant="bar" />
            {preferred ? <span className="small muted wide-only">{preferred === 'keep' ? `到期后保留 ${preferredKeep?.keepHours ?? preferredKeep?.hours ?? ''} 小时` : '到期时释放'}</span> : null}
          </>
        ) : v.state === 'KEPT' && v.keep?.until ? (
          <span className="small">至 {formatClock(v.keep.until)}</span>
        ) : null}
        {!ws.preparing || hourly ? (
          ws.role === 'O' ? (
            <span className="small muted wide-only" data-cost="">
              {hourly ? `${formatRange(hourly, cur)}/h（估算）` : '每小时估算未提供'}
            </span>
          ) : (
            <button type="button" className="btn sm ghost wide-only" onClick={p.onCost} title="费用计（估算）" data-cost="">
              {hourly ? `${formatRange(hourly, cur)}/h` : '每小时估算未提供'}
              {ws.preparing ? '' : ` · 已产生 ${accrued ? formatRange(accrued, cur) : '未提供'}`}
            </button>
          )
        ) : null}
      </div>
      {canEnd ? (
        <span className="row wide-only bar-acts">
          {left > 0 ? (
            <button type="button" className="btn sm" aria-disabled={block ? true : undefined} aria-describedby={block ? reasonId : undefined} onClick={() => (block ? undefined : p.onExtend())} data-extend="">
              延长 {v.limits?.extensionMinutes ?? 30} 分钟（剩 {left} 次）
            </button>
          ) : (
            <button type="button" className="btn sm" aria-disabled="true" aria-describedby={reasonId}>
              已延长 {used} 次（上限）
            </button>
          )}
          <span id={reasonId} className="sr">
            {block ? EXTEND_REASON_TEXT[block] : '可以延长'}
          </span>
          <button type="button" className="btn sm" onClick={p.onEnd} data-end="">
            结束实验…
          </button>
        </span>
      ) : null}
      {canCancel ? (
        <button type="button" className="btn sm wide-only" onClick={p.onCancel} data-cancel-open="">
          取消…
        </button>
      ) : null}
      <Disclosure label={<Icon name="dots" />} ariaLabel="更多" buttonClassName="btn sm ghost icon">
        {(close) => (
          <>
            {canCancel ? (
              <button
                type="button"
                className="mi"
                onClick={() => {
                  close();
                  p.onCancel();
                }}
              >
                取消…
              </button>
            ) : null}
            {canEnd ? (
              <>
                <button
                  type="button"
                  className="mi"
                  aria-disabled={block ? true : undefined}
                  title={block ? EXTEND_REASON_TEXT[block] : undefined}
                  onClick={() => {
                    if (block) return;
                    close();
                    p.onExtend();
                  }}
                >
                  延长 {v.limits?.extensionMinutes ?? 30} 分钟（剩 {left} 次）
                </button>
                <button
                  type="button"
                  className="mi"
                  onClick={() => {
                    close();
                    p.onEnd();
                  }}
                >
                  结束实验…
                </button>
              </>
            ) : null}
            {ws.role !== 'O' && !ws.preparing ? (
              <button
                type="button"
                className="mi"
                onClick={() => {
                  close();
                  p.onCost();
                }}
              >
                费用计明细
              </button>
            ) : null}
            <button
              type="button"
              className="mi"
              onClick={() => {
                close();
                p.onShortcuts();
              }}
            >
              快捷键帮助
            </button>
            {ws.learner ? (
              <button
                type="button"
                className="mi"
                onClick={() => {
                  close();
                  p.onTermSettings();
                }}
              >
                终端设置…
              </button>
            ) : null}
            <div className="mi-group" role="group" aria-label="主题">
              {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="mi"
                  aria-pressed={getThemePref() === t}
                  onClick={() => {
                    setThemePref(t);
                    close();
                  }}
                >
                  主题：{t === 'system' ? '跟随系统' : t === 'light' ? '亮' : '暗'}
                </button>
              ))}
            </div>
            <Link className="mi" to={`/sessions/${ws.sid}`} onClick={() => close()}>
              会话详情
            </Link>
            {ws.learner && ws.live ? (
              <button
                type="button"
                className="mi"
                onClick={() => {
                  close();
                  p.onCredentials();
                }}
              >
                查看 CloudAlbum 管理员账号
              </button>
            ) : null}
            <Link className="mi" to="/labs" onClick={() => close()}>
              卡片目录（全站导航）
            </Link>
          </>
        )}
      </Disclosure>
      {targets.length ? (
        <div className="wsbar-targets small muted">
          本卡将依次启用：
          {targets.map((t, i) => (
            <span key={t}>
              {i ? ' → ' : ''}
              {t}
              {doneModules.has(t) ? ' ✓' : ''}
            </span>
          ))}
        </div>
      ) : null}
    </header>
  );
}

interface SessionViewExtra {
  preferredDisposition?: 'destroy' | 'keep' | null;
  preferredKeep?: { keepHours?: number; hours?: number } | null;
}
