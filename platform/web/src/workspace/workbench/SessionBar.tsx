/**
 * 工作台顶栏 SessionBar（08 P05.2、§5.3；03 §2.2、§2.3），高 48px：
 * 平台标志、“‹ 目录”（离开不需要确认）→ 卡片标识（[服务] / [场景] + 服务图标 ServiceGlyph，场景卡下方是目标模块的图标链，
 * 已接入的打勾；有变体时附变体名）→ 状态胶囊 → 倒计时（剩余 + 绝对时间；准备阶段“沙漏 m:ss ‖”，“倒计时未开始”给读屏与悬停）
 * → 费用计（L A：硬币 ≈ a～b/h · 叠币 ≈ x，完整说明在 aria-label，点击打开明细；O：只显示每小时估算）→ 延长（“+30 分钟 · 剩 n 次”，
 * 可访问名称仍是完整句子；置灰时原因节点总是渲染）/ 结束实验…（准备阶段为“取消…”）→ 溢出菜单。09 I6 e：图标 + 数字代替文字。
 * < 768px 折叠为“卡片 id · 状态 · 剩余时间 ⋯”，延长与结束收进 ⋯。
 */
import { Link } from 'react-router-dom';
import { getThemePref, setThemePref, type ThemePref } from '../../app/theme';
import { formatClock, formatCountdown } from '../../lib/format';
import { BrandMark, Countdown, Disclosure, Icon, SessionStatePill, Shape, displayState, useSecondTick } from '../../ui';
import { glyphModule, ServiceGlyph } from '../../ui/glyphs';
import { useWorkspace } from '../context';
import { accruedOf, formatRange, hourlyRangeOf } from '../model/cost';
import { EXTEND_REASON_TEXT, extendBlock } from '../model/expiry';
import { WsIcon } from '../visual/icons';

import { getLocale, LOCALE_NAMES, LOCALES, msg, setLocale, t } from '../../i18n';
import { W } from '../strings';
export interface SessionBarProps {
  onExtend: () => void;
  onEnd: () => void;
  onCancel: () => void;
  onCost: () => void;
  onShortcuts: () => void;
  onTermSettings: () => void;
  onCredentials: () => void;
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
      <Link className="brand" to="/labs" title={msg.app.fullName}>
        <BrandMark />
      </Link>
      <Link className="btn sm ghost" to="/labs">
        {W.bar.catalog}
      </Link>
      <div className="ttl">
        {/* 每个画面一个 h1（08 §8.2）；工作台的可见标题是这一行，h1 只给读屏 */}
        <h1 className="sr" tabIndex={-1}>
          {t(W.bar.heading, { title: lab?.title ?? v.labId })}
        </h1>
        <span className="tag">{lab?.kind === 'scenario' ? W.bar.scenario : W.bar.service}</span>
        {blocks.map((s) => (
          <ServiceGlyph key={s.id} id={s.module ?? s.id} size={20} tooltip className="bar-glyph" />
        ))}
        <span className="mono small">{v.labId}</span>
        <span className="t small muted wide-only">
          {lab?.title ?? ''}
          {v.variant && v.variant !== 'default' ? t(W.bar.variant, { v: v.variant }) : ''}
        </span>
      </div>
      <div className="clock">
        <SessionStatePill state={state} size="sm" />
        {ws.preparing ? (
          <span className="small bar-elapsed" title={W.bar.notStarted} data-elapsed="">
            <WsIcon name="hourglass" />
            <span className="sr">{W.bar.elapsedLabel}</span>
            <ElapsedClock since={v.createdAt} now={ws.now} />
            <Icon name="pause" />
            <span className="sr">{W.bar.notStarted}</span>
          </span>
        ) : v.deadlineAt && ['READY', 'RUNNING', 'EXPIRING'].includes(v.state) ? (
          <>
            {v.state === 'READY' ? <span className="small muted wide-only">{W.bar.readyRemaining}</span> : null}
            <Countdown deadlineAt={v.deadlineAt} now={ws.now} variant="bar" />
            {preferred ? <span className="small muted wide-only">{preferred === 'keep' ? t(W.bar.keepAfter, { n: preferredKeep?.keepHours ?? preferredKeep?.hours ?? '' }) : W.bar.releaseAtExpiry}</span> : null}
          </>
        ) : v.state === 'KEPT' && v.keep?.until ? (
          <span className="small">{t(W.bar.keptUntil, { t: formatClock(v.keep.until) })}</span>
        ) : null}
        {!ws.preparing || hourly ? (
          ws.role === 'O' ? (
            <span className="small muted wide-only bar-cost" data-cost="">
              <WsIcon name="coin" />
              <span className="sr">{W.bar.costTitle}</span>
              {hourly ? t(W.bar.hourlyEstimate, { range: formatRange(hourly, cur) }) : W.bar.noHourly}
            </span>
          ) : (
            <button
              type="button"
              className="btn sm ghost wide-only bar-cost"
              onClick={p.onCost}
              title={W.bar.costTitle}
              aria-label={
                ws.preparing
                  ? t(W.bar.costAriaHourly, { hourly: hourly ? formatRange(hourly, cur) : W.bar.notProvided })
                  : t(W.bar.costAria, { hourly: hourly ? formatRange(hourly, cur) : W.bar.notProvided, accrued: accrued ? formatRange(accrued, cur) : W.bar.notProvided })
              }
              data-cost=""
            >
              <WsIcon name="coin" />
              <span>{hourly ? t(W.bar.hourly, { range: formatRange(hourly, cur) }) : W.bar.noHourly}</span>
              {ws.preparing ? null : (
                <>
                  <WsIcon name="sum" />
                  <span>{accrued ? formatRange(accrued, cur) : W.bar.notProvided}</span>
                </>
              )}
            </button>
          )
        ) : null}
      </div>
      {canEnd ? (
        <span className="row wide-only bar-acts">
          {left > 0 ? (
            <button
              type="button"
              className="btn sm bar-extend"
              aria-label={t(W.bar.extend, { n: v.limits?.extensionMinutes ?? 30, left })}
              title={t(W.bar.extend, { n: v.limits?.extensionMinutes ?? 30, left })}
              aria-disabled={block ? true : undefined}
              aria-describedby={block ? reasonId : undefined}
              onClick={() => (block ? undefined : p.onExtend())}
              data-extend=""
            >
              <WsIcon name="extend" />
              <span>{t(W.bar.extendShort, { n: v.limits?.extensionMinutes ?? 30 })}</span>
              <span className="bar-count">{t(W.bar.extendLeft, { left })}</span>
            </button>
          ) : (
            <button type="button" className="btn sm bar-extend" aria-disabled="true" aria-describedby={reasonId}>
              <WsIcon name="extend" />
              {t(W.bar.extendedMax, { n: used })}
            </button>
          )}
          <span id={reasonId} className="sr">
            {block ? EXTEND_REASON_TEXT[block] : W.bar.canExtend}
          </span>
          <button type="button" className="btn sm" onClick={p.onEnd} data-end="">
            <WsIcon name="stop" />
            {W.bar.end}
          </button>
        </span>
      ) : null}
      {canCancel ? (
        <button type="button" className="btn sm wide-only" onClick={p.onCancel} data-cancel-open="">
          {W.bar.cancel}
        </button>
      ) : null}
      <Disclosure label={<Icon name="dots" />} ariaLabel={W.bar.more} buttonClassName="btn sm ghost icon">
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
                {W.bar.cancel}
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
                  {t(W.bar.extend, { n: v.limits?.extensionMinutes ?? 30, left })}
                </button>
                <button
                  type="button"
                  className="mi"
                  onClick={() => {
                    close();
                    p.onEnd();
                  }}
                >
                  {W.bar.end}
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
                {W.bar.costDetail}
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
              {W.bar.shortcuts}
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
                {W.bar.termSettings}
              </button>
            ) : null}
            <div className="mi-group" role="group" aria-label={W.bar.theme}>
              {(['system', 'light', 'dark'] as ThemePref[]).map((th) => (
                <button
                  key={th}
                  type="button"
                  className="mi"
                  aria-pressed={getThemePref() === th}
                  onClick={() => {
                    setThemePref(th);
                    close();
                  }}
                >
                  {t(W.bar.themeItem, { v: th === 'system' ? msg.account.themeSystem : th === 'light' ? msg.account.themeLight : msg.account.themeDark })}
                </button>
              ))}
            </div>
            <div className="mi-group" role="group" aria-label={W.bar.language}>
              {LOCALES.map((l) => (
                <button
                  key={l}
                  type="button"
                  className="mi"
                  lang={l}
                  aria-pressed={getLocale() === l}
                  onClick={() => {
                    close();
                    setLocale(l);
                  }}
                >
                  {LOCALE_NAMES[l]}
                </button>
              ))}
            </div>
            <Link className="mi" to={`/sessions/${ws.sid}`} onClick={() => close()}>
              {W.bar.sessionDetail}
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
                {W.bar.adminAccount}
              </button>
            ) : null}
            <Link className="mi" to="/labs" onClick={() => close()}>
              {W.bar.catalogNav}
            </Link>
          </>
        )}
      </Disclosure>
      {targets.length ? (
        <div className="wsbar-targets small muted">
          <ol className="bar-chain" aria-label={W.bar.targets}>
            {targets.map((id) => {
              const done = doneModules.has(id);
              return (
                <li key={id} data-module={id} data-done={done ? '' : undefined}>
                  <ServiceGlyph id={id} size={16} tone={done ? 'solid' : 'muted'} tooltip />
                  <span>{glyphModule(id)?.short ?? id}</span>
                  {done ? (
                    <span className="st pass">
                      <Shape name="check" />
                      <span className="sr">{W.bar.targetDone}</span>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </header>
  );
}

interface SessionViewExtra {
  preferredDisposition?: 'destroy' | 'keep' | null;
  preferredKeep?: { keepHours?: number; hours?: number } | null;
}
