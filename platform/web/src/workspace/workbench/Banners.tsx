/**
 * 工作台横幅（08 P05.9、P05.12；顶栏下方，不遮挡终端）：T-15 即将到期（琥珀，延长 / 到期后保留 / 现在结束）、到期预检的“还差什么”、
 * 保留中、释放未完成、只读存档、环境异常（窗口外；窗口内追加“属预期”说明）、预算 end-active、平台动作进行中、提交结果条。
 * 横幅只在内容变化时重绘；T-15 的读屏播报由全局 useExpiryAnnouncements 负责（15、5、1 分钟与 0 各一次），这里不重复。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionEvent } from '../../api/types';
import { formatClock } from '../../lib/format';
import { Button, Icon, Shape } from '../../ui';
import { useWorkspace } from '../context';
import { expiryPhase, showT15Banner } from '../model/expiry';
import { actionTitle } from '../manual/PlatformAction';

export interface BannerProps {
  onExtend: () => void;
  onEnd: (when: 'now' | 'at-expiry') => void;
  onRepair: () => void;
  extendBlocked: string | null;
}

interface AttemptResult {
  to: string;
  missing?: number;
  at: string;
}

function lastAttempt(events: readonly SessionEvent[]): AttemptResult | null {
  const e = [...events].reverse().find((x) => x.type === 'attempt.state_changed');
  if (!e) return null;
  const d = e.data as { from?: string; to?: string; missing?: number };
  return d.to ? { to: d.to, ...(typeof d.missing === 'number' ? { missing: d.missing } : {}), at: e.id } : null;
}

export function WorkspaceBanners({ onExtend, onEnd, onRepair, extendBlocked }: BannerProps) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const v = ws.view;
  const phase = expiryPhase(v, ws.now());
  const out: React.ReactNode[] = [];
  const canEnd = ws.allowed.includes('end');
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const result = useMemo(() => lastAttempt(ws.data.events), [ws.data.events]);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (ws.live && showT15Banner(phase) && v.deadlineAt) {
    const mins = Math.max(1, Math.ceil((Date.parse(v.deadlineAt) - ws.now()) / 60_000));
    out.push(
      <div key="t15" className="wsban amber" data-banner="t15">
        <Shape name="tri" />
        <span className="b-body">
          剩余 {mins} 分钟（{formatClock(v.deadlineAt)} 到期）。到期后自动收回访问并释放资源。
        </span>
        {canEnd ? (
          <>
            <button type="button" className="btn sm" aria-disabled={extendBlocked ? true : undefined} aria-describedby="ws-ban-ext" onClick={() => (extendBlocked ? undefined : onExtend())}>
              延长 {v.limits?.extensionMinutes ?? 30} 分钟
            </button>
            <span id="ws-ban-ext" className="sr">
              {extendBlocked ?? '可以延长'}
            </span>
            {ws.allowed.includes('end-keep') ? (
              <button type="button" className="btn sm" onClick={() => onEnd('at-expiry')}>
                到期后保留环境…
              </button>
            ) : null}
            <button type="button" className="btn sm" onClick={() => onEnd('now')}>
              现在结束…
            </button>
          </>
        ) : null}
      </div>,
    );
    const p = ws.data.progress.data;
    const steps = ws.data.lab.data?.steps ?? [];
    if (p?.missing.length) {
      out.push(
        <div key="precheck" className="wsban grey" data-banner="precheck">
          <Shape name="clock" />
          <span className="b-body small">
            到期预检：还差 {p.missing.map((m) => `第 ${steps.findIndex((s) => s.id === m) + 1} 步`).join('、')}。结束时平台会自动做最终复核。
          </span>
        </div>,
      );
    }
  }
  if (v.state === 'KEPT') {
    out.push(
      <div key="kept" className="wsban amber" data-banner="kept">
        <Shape name="dia" />
        <span className="b-body">环境保留中{v.keep?.until ? ` · 至 ${formatClock(v.keep.until)}` : ''}。保留期间没有终端与控制台访问。</span>
        <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end`)}>
          管理保留
        </Button>
      </div>,
    );
  }
  if (v.state === 'CLEANUP_FAILED' && ws.render.screen === 'P05') {
    out.push(
      <div key="cf" className="wsban red" role="alert" data-banner="cleanup-failed">
        <Shape name="tri" />
        <span className="b-body">释放未完成：有资源没能自动删除，它们仍可能计费。</span>
        <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end#manual`)}>
          查看清单
        </Button>
      </div>,
    );
  }
  if (v.state === 'ENDED' && ws.render.screen === 'P05') {
    out.push(
      <div key="ended" className="wsban grey" data-banner="archive">
        <Shape name="sq" />
        <span className="b-body">已结束 · 只读存档。本会话打开过的终端列在右侧终端区。</span>
        <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/report`)}>
          查看报告
        </Button>
      </div>,
    );
  }
  if (ws.live && ws.guard.envDegraded) {
    out.push(
      <div key="deg" className="wsban amber" role="alert" data-banner="env-degraded">
        <Shape name="tri" />
        <span className="b-body">
          实验机的管理通道不可达：终端与本地检测暂时不可用。
          {ws.outage ? ` 本步骤会让管理通道暂时不可达：检测会显示“通道不可达”，属预期，窗口结束后（${formatClock(ws.outage.until)}）重新检测即可。` : ''}
          <details className="small">
            <summary>常见原因</summary>
            给 CloudAlbumAppRole 加了拒绝策略或“撤销活动会话”；私有放置缺 NAT 或 ssm / ssmmessages / ec2messages 终端节点；实例配置文件被替换；Agent 被停止。
          </details>
        </span>
        {ws.learner ? (
          <>
            <Button size="sm" onClick={onRepair}>
              修复环境
            </Button>
            {canEnd ? (
              <Button size="sm" onClick={() => onEnd('now')}>
                结束实验…
              </Button>
            ) : null}
          </>
        ) : null}
      </div>,
    );
  }
  if (ws.live && ws.guard.budgetEndActive) {
    out.push(
      <div key="budget" className="wsban red" role="alert" data-banner="budget">
        <Shape name="sq" />
        <span className="b-body">本月费用已超过预算，平台将在 10 分钟后结束本实验。</span>
      </div>,
    );
  }
  const running = (ws.data.moduleOps.data?.items ?? []).find((o) => o.source === 'platform' && !o.finishedAt && !['succeeded', 'failed'].includes((o.status ?? o.state ?? '').toLowerCase()));
  if (ws.live && running) {
    out.push(
      <div key="op" className="wsban blue" role="status" data-banner="module-op">
        <Shape name="spin" spin />
        <span className="b-body">
          平台正在修改环境：{actionTitle(running.actionId ?? running.op ?? '平台动作')}
          {running.runId ? `（运行器 ${running.runId}）` : ''}
        </span>
      </div>,
    );
  }
  if (result && dismissedResult !== result.at && (ws.live || v.state === 'ENDED')) {
    if (result.to === 'completed' || result.to === 'completed_manual') {
      const badge = ws.data.lab.data?.badge?.title;
      out.push(
        <div key="res" className="wsban green" role="status" data-banner="result">
          <Shape name="check" />
          <span className="b-body">
            {result.to === 'completed' ? '已完成（全自动）' : '已完成（含手动）'}。{badge ? `获得徽章“${badge}”。` : ''}你可以结束并清理，也可以继续探索（倒计时照常）。
          </span>
          {canEnd ? (
            <Button size="sm" variant="primary" onClick={() => onEnd('now')}>
              结束并清理…
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setDismissedResult(result.at)}>
            继续探索
          </Button>
        </div>,
      );
    } else if (result.to === 'active' && result.missing) {
      out.push(
        <div key="res" className="wsban amber" role="status" data-banner="result">
          <Shape name="tri" />
          <span className="b-body">提交未通过：还差 {result.missing} 项。修好之后可以再次提交。</span>
          <button type="button" className="btn sm ghost icon" aria-label="关闭提醒" onClick={() => setDismissedResult(result.at)}>
            <Icon name="x" />
          </button>
        </div>,
      );
    }
  }
  if (!out.length) return null;
  return (
    <div className="wsbans" role="region" aria-label="工作台提醒">
      {out}
    </div>
  );
}
