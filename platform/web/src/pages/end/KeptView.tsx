/**
 * P07-K 保留中的环境（08 P07-K；02 §8；§5.4 KeepPanel）。
 * - 至 hh:mm 自动释放（剩余倒计时，K1 / K2 编码）；来自、节省模式、环境年龄与上限、启用的模块；
 * - 仍在计费（估算，按当前实际资源）：会话视图 `env.hourlyEstimate`（没有金额时写“未知”，不编造价格），计费资源取 `GET …/cost`（L A）；
 * - 操作（学员）：在下一张卡片中复用、继续本卡片（`/labs/:labId?start=1&reuse=<envId>`）、延长保留…（KEEP 报价 → 确认 → keep/extend）、
 *   立即释放…（确认后 keep/release，202，页面切回回收进度；409 REUSE_IN_PROGRESS 时说明“正在被新会话接管”）；
 *   `allowedActions` 不含 keep-extend（卸载中、预算超限）时置灰并说明原因；维护模式不影响。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionView } from '../../api/types';
import { useAuth, useServices } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { allowedActionsOf } from '../../app/sessionRouting';
import { formatDate, formatSpan } from '../../lib/format';
import { BILLING_TEXT, Button, Countdown, Icon, Shape } from '../../ui';
import { useApiData } from '../sessions/data';
import { formatMoneyRange, hourlyRange } from '../sessions/sessionText';
import '../sessions/pages.css';
import { KeepExtendDialog, ReleaseKeepDialog } from './KeepDialogs';
import { normalizeResource } from './resources';
import { ResourceStages } from './ResourceStages';

import { msg, rich, t } from '../../i18n';

const KV = msg.end.kept;
interface CurrentEnvironment {
  envId?: string;
  envName?: string;
  enabledModules?: string[];
  saveMode?: boolean | null;
  createdAt?: string;
  maxAgeUntil?: string | null;
  keepUntil?: string | null;
  reservedBy?: string | null;
  session?: { sessionId?: string } | null;
}

interface SessionCost {
  currency?: string;
  billable?: { resourceKey?: string | null; type?: string | null; name?: string | null; billing?: string }[];
}

export function KeptView({ view }: { view: SessionView }) {
  const sid = view.sessionId;
  const { clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const L = role === 'L';
  const LA = role === 'L' || role === 'A';
  const status = useGlobalStatus();
  const uninstalling = status.platform.data?.mode === 'UNINSTALLING' || status.guardrails?.uninstalling === true;
  const budgetExceeded = status.guardrails?.budget?.state === 'EXCEEDED';
  const env = useApiData<CurrentEnvironment>(`env:${sid}`, 'getCurrentEnvironment', {}, 60_000);
  const cost = useApiData<SessionCost>(LA ? `cost:${sid}` : null, 'getSessionCost', { params: { sid } });
  const resources = useApiData<{ items?: Record<string, unknown>[] }>(LA ? `res:${sid}` : null, 'listSessionResources', { params: { sid } });
  const [dialog, setDialog] = useState<'extend' | 'release' | null>(null);

  const actions = allowedActionsOf(view, { role, nowMs: clock.now(), uninstalling, budgetExceeded, envHealthy: true });
  const canExtend = actions.includes('keep-extend');
  const canRelease = actions.includes('keep-release');
  const extendReason = canExtend ? null : uninstalling ? KV.uninstalling : budgetExceeded ? KV.budget : KV.cannot;
  const ce = env.data && (env.data.session?.sessionId === sid || env.data.envId === view.env?.envId) ? env.data : null;
  const keepUntil = (view.keep as { until?: string | null } | null)?.until ?? view.env?.keepUntil ?? ce?.keepUntil ?? null;
  const saveMode = (view.keep as { saveMode?: boolean } | null)?.saveMode ?? ce?.saveMode ?? null;
  const hourly = hourlyRange(view.env?.hourlyEstimate);
  const money = hourly ? formatMoneyRange(hourly.low, hourly.high, cost.data?.currency ?? 'USD', msg.end.keep.perHour) : null;
  const billable = cost.data?.billable ?? [];
  const hasAsg = billable.some((b) => /AutoScaling/.test(b.type ?? ''));
  const envId = view.env?.envId ?? ce?.envId ?? null;
  const ledger = (resources.data?.items ?? []).map(normalizeResource);

  return (
    <div className="stack-24" data-screen="P07-K">
      <div>
        <nav className="crumbs-row" aria-label={KV.crumbs}>
          <Link to="/sessions">{KV.mySessions}</Link>
          <span aria-hidden="true">›</span>
          <Link className="mono" to={`/sessions/${sid}`}>
            {sid}
          </Link>
          <span aria-hidden="true">›</span>
          <span>{KV.title}</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>
              <span className="st kept">
                <Shape name="dia" />
              </span>{' '}
              {t(KV.heading, { labId: view.labId })}
            </h1>
            <span className="sub">{rich(KV.autoRelease, { until: keepUntil ? <Countdown deadlineAt={keepUntil} now={clock.now} variant="keep" /> : KV.untilUnknown })}</span>
          </div>
        </div>
      </div>

      <dl className="kv">
        <dt>{KV.from}</dt>
        <dd>{t(KV.fromValue, { labId: view.labId, when: view.stateEnteredAt ? t(KV.endedAt, { t: formatDate(view.stateEnteredAt, clock.now()) }) : '—' })}</dd>
        <dt>{KV.saveMode}</dt>
        <dd>{saveMode === null ? '—' : saveMode ? KV.saveOn : KV.saveOff}</dd>
        <dt>{KV.envAge}</dt>
        <dd>
          {ce?.createdAt ? formatSpan(clock.now() - Date.parse(ce.createdAt)) : '—'}
          {ce?.maxAgeUntil ? t(KV.maxAge, { t: formatDate(ce.maxAgeUntil, clock.now()) }) : ''}
        </dd>
        <dt>{KV.modules}</dt>
        <dd className="mono">{ce?.enabledModules?.length ? ce.enabledModules.join(KV.listSep) : '—'}</dd>
      </dl>

      <div className="box stack-8" data-section="keep-cost">
        <b>
          {t(KV.billing, { money: money ?? KV.unknown })}
          {money ? '' : KV.unknownNote}
        </b>
        {LA && billable.length ? (
          <ul className="small">
            {billable.map((b, i) => (
              <li key={b.resourceKey ?? i}>
                <span className="mono">{b.type ?? '—'}</span>
                {b.billing ? ` · ${BILLING_TEXT[b.billing as keyof typeof BILLING_TEXT] ?? b.billing}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
        {saveMode === false ? <p className="small">{KV.saveOffNote}</p> : null}
        {hasAsg ? <p className="small">{KV.asg}</p> : null}
        <p className="small muted">{KV.estimate}</p>
      </div>

      {ce?.reservedBy ? (
        <div className="note blue" role="status">
          <Shape name="clock" />
          <span>{KV.reserved}</span>
        </div>
      ) : null}

      {L ? (
        <div className="row no-print" data-actions="keep">
          {!uninstalling ? (
            <Link className="btn primary" to="/labs">
              {KV.reuseNext}
            </Link>
          ) : null}
          {!uninstalling && envId ? (
            <Link className="btn" to={`/labs/${encodeURIComponent(view.labId)}?start=1&reuse=${encodeURIComponent(envId)}`}>
              {KV.continue}
            </Link>
          ) : null}
          <Button onClick={() => setDialog('extend')} disabledReason={extendReason}>
            {KV.extend}
          </Button>
          {canRelease ? (
            <Button variant="danger" onClick={() => setDialog('release')}>
              {KV.release}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="note">
        <Icon name="lock" />
        <span>{KV.noAccess}</span>
      </div>

      {LA && resources.loaded ? <ResourceStages sid={sid} items={ledger} heading={t(KV.resources, { n: ledger.length })} canUnmask={L} /> : null}

      {dialog === 'extend' ? <KeepExtendDialog view={view} onClose={() => setDialog(null)} /> : null}
      {dialog === 'release' ? <ReleaseKeepDialog view={view} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
