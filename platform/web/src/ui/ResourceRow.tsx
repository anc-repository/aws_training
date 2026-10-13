/**
 * 资源行 ResourceRow（08 §5.4；数据 01 §7.3 SessionResource）与待人工处理条目 ManualItemCard（02 §7.9、§9.2 #32）。
 *
 * 变体：`reclaim`（回收进度中的一行）、`compact`（会话详情、紧凑列表）、`manual`（带处理指引的卡片）。
 * 状态：cleanupState 8 种；严重级别（阻塞 ■、需复核 ▲、信息 ●）；计费方式；慢项提示；核对中；你已处理。
 * 名称与 ARN 经界面打码器显示（等宽、可折行）；操作按钮带对象名的 aria-label。
 * 字段按 01 的写法（resourceType、name/arn、manualHint{consoleUrl, cli, note}、discoveredBy、creatorSessionName），兼容 02 §7.9 的旧写法。
 */
import type { CleanupState, ResourceBilling, ResourceSeverity } from '@atl/shared';
import { formatDate } from '../lib/format';
import { redact } from '../lib/redact';
import { Button } from './Button';
import { CommandBlock } from './CommandBlock';
import { Icon } from './Icon';
import { Status } from './Status';
import { BILLING_TEXT, CLEANUP_STATE_META, SEVERITY_META } from './semantics';

export interface ResourceRowData {
  resourceKey: string;
  resourceType: string;
  name?: string | null;
  arn?: string | null;
  region?: string | null;
  cleanupState: CleanupState;
  severity?: ResourceSeverity | null;
  billing?: ResourceBilling | null;
  discoveredBy?: string | null;
  creatorSessionName?: string | null;
  attempts?: number | null;
  lastAttemptAt?: string | null;
  reason?: string | null;
  manualHint?: { consoleUrl?: string | null; cli?: string | null; note?: string | null } | null;
  /** 02 §7.9 的旧字段名（兼容）。 */
  hint?: { consoleUrl?: string | null; cli?: string | null } | null;
  type?: string | null;
  id?: string | null;
}

export interface ResourceRowProps {
  resource: ResourceRowData;
  variant?: 'reclaim' | 'compact' | 'manual';
  /** 慢项提示（例如 CloudFront 分配“正在禁用，部署完成后删除”）。 */
  slowHint?: string | null;
  /** “我已处理”后正在核对。 */
  verifying?: boolean;
  /** 显示完整值（不打码）。 */
  unmasked?: boolean;
  onResolve?: () => void;
  onRetry?: () => void;
}

function nameOf(r: ResourceRowData): string {
  return r.name ?? r.arn ?? r.id ?? r.resourceKey;
}

export function ResourceRow({ resource: r, variant = 'reclaim', slowHint, verifying, unmasked, onResolve, onRetry }: ResourceRowProps) {
  const show = (s: string) => (unmasked ? s : redact(s));
  const type = r.resourceType || r.type || '';
  const name = nameOf(r);
  const state = verifying ? { text: '核对中', shape: 'clock' as const, tone: 'pend' as const } : CLEANUP_STATE_META[r.cleanupState];
  if (variant === 'manual') return <ManualItemCard resource={r} verifying={verifying} unmasked={unmasked} onResolve={onResolve} onRetry={onRetry} />;
  return (
    <div className={variant === 'compact' ? 'resrow compact' : 'resrow'} tabIndex={0} data-resource={r.resourceKey} data-state={r.cleanupState}>
      <Status meta={state} />
      <span>
        <span className="rtype">{type}</span>
        <br />
        <span className="rname">{show(name)}</span>
      </span>
      {variant === 'reclaim' ? (
        <span className="small muted">
          {r.billing ? BILLING_TEXT[r.billing] : ''}
          {r.severity && r.severity !== 'INFO' ? (
            <>
              {' '}
              <Status meta={SEVERITY_META[r.severity]} />
            </>
          ) : null}
        </span>
      ) : null}
      {variant === 'reclaim' && (slowHint || r.reason) ? <span className="rmeta">{slowHint ?? r.reason}</span> : null}
    </div>
  );
}

export interface ManualItemCardProps {
  resource: ResourceRowData;
  verifying?: boolean;
  unmasked?: boolean;
  onResolve?: () => void;
  onRetry?: () => void;
}

export function ManualItemCard({ resource: r, verifying, unmasked, onResolve, onRetry }: ManualItemCardProps) {
  const show = (s: string) => (unmasked ? s : redact(s));
  const type = r.resourceType || r.type || '';
  const name = nameOf(r);
  const hint = r.manualHint ?? (r.hint ? { ...r.hint, note: null } : null);
  const resolved = r.cleanupState === 'RESOLVED_BY_LEARNER' || r.cleanupState === 'DELETED';
  const sev = r.severity ?? 'BLOCKING';
  const cls = ['manitem', resolved ? 'done' : sev === 'REVIEW' ? 'review' : sev === 'INFO' ? 'info' : ''].filter(Boolean).join(' ');
  return (
    <article className={cls} aria-label={`${type} ${show(name)}`} data-resource={r.resourceKey}>
      <div className="row">
        <Status meta={SEVERITY_META[sev]} />
        {r.billing ? <span className="tag">{BILLING_TEXT[r.billing]}</span> : null}
        <span className="mono small">{type}</span>
        <span className="mono small wrap-any">
          <b>{show(name)}</b>
        </span>
        {r.region ? <span className="small faint">{r.region}</span> : null}
        {verifying ? <Status meta={{ text: '核对中', shape: 'clock', tone: 'pend' }} /> : resolved ? <Status meta={CLEANUP_STATE_META.RESOLVED_BY_LEARNER} /> : null}
      </div>
      <div className="small">
        {r.reason ? <>原因：{r.reason} · </> : null}
        {r.discoveredBy ? <>来源：{r.discoveredBy} · </> : null}
        {r.creatorSessionName ? (
          <>
            创建者会话名 <span className="mono">{r.creatorSessionName}</span> ·{' '}
          </>
        ) : null}
        {r.attempts != null ? <>已尝试 {r.attempts} 次</> : null}
        {r.lastAttemptAt ? <> · 最后尝试 {formatDate(r.lastAttemptAt)}</> : null}
      </div>
      {hint?.consoleUrl ? (
        <div className="small">
          控制台{' '}
          <a href={hint.consoleUrl} target="_blank" rel="noopener noreferrer">
            在 AWS 控制台中打开 <Icon name="ext" />
            <span className="sr">（新标签页）</span>
          </a>
          （以你自己的 AWS 登录打开，平台不签发新的联合登录）
        </div>
      ) : null}
      {hint?.cli ? <CommandBlock text={hint.cli} runsOn="local" copyOnly label={`${type} 的清理命令`} /> : null}
      {hint?.note ? <p className="small muted">{hint.note}</p> : null}
      {!resolved && (onResolve || onRetry) ? (
        <div className="row">
          {onResolve ? (
            <Button size="sm" busy={verifying} busyText="正在核对…" onClick={onResolve} aria-label={`我已处理 ${show(name)}，重新核对`}>
              我已处理，重新核对
            </Button>
          ) : null}
          {onRetry ? (
            <Button size="sm" variant="ghost" onClick={onRetry} aria-label={`重试回收 ${show(name)}`}>
              重试回收
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
