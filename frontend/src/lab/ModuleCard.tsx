// /lab 模块卡片（总纲 8.1）：内容全部来自 registry 的 lab 段与 capabilities，模块设计者只填注册表，不写前端代码。
// 布局：标题（机能 + id + 类型标记）→ 状态徽章与驱动 → 本地 / AWS 实现各一行 → 依赖芯片 → 对比方式 → 最近一次结果的关键指标差值
// → 按钮：运行 A/B（仅支持运行时 A/B 且模块已启用、管理员）、如何切换、详情。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CapabilitiesResponse, ModuleCapability, ModuleId, RegistryModule } from '@cloudalbum/contracts';
import { isModuleId } from '@cloudalbum/contracts';
import type { LabResultRow } from '../api/types';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { MVP_MODULES, typeMark } from '../capabilities/registry';
import { AbRunner } from './AbRunner';
import { Dialog } from './Dialog';
import { COMPARE_LABEL, CREDENTIALS_LABEL, deltaText, latestDelta } from './labUtil';
import { SwitchHowTo } from './SwitchHowTo';

export function statusText(cap: ModuleCapability): string {
  if (cap.status === 'off') return `off · 本地实现 ${cap.localHealth ?? 'ok'}`;
  return cap.status;
}

export function DepChips({ id, reg, cap, caps }: { id: ModuleId; reg: RegistryModule; cap: ModuleCapability; caps: CapabilitiesResponse }) {
  const needs = [...new Set((reg.requires ?? []).flatMap((r) => r.need.flatMap((n) => n.split('|').map((x) => x.trim()))))];
  const modules = needs.filter(isModuleId).filter((m) => m !== id);
  const unsatisfied = cap.deps ? !cap.deps.satisfied : false;
  const iamOn = caps.modules.iam?.status !== 'off';
  return (
    <div className="chips" aria-label="依赖">
      {modules.map((m) => {
        const on = caps.modules[m]?.status !== 'off';
        return (
          <span key={m} className={`chip ${on ? 'chip-hit' : unsatisfied ? 'chip-error' : 'chip-local'}`} title={on ? '已启用' : '未启用（条件依赖：只有命中对应开关时才需要）'}>
            {m}
          </span>
        );
      })}
      {reg.credentials !== 'none' && (
        <span className={`chip ${reg.credentials === 'required' ? (iamOn ? 'chip-hit' : 'chip-error') : 'chip-local'}`} title={CREDENTIALS_LABEL[reg.credentials]}>
          凭证{reg.credentials === 'required' ? '必需' : '可选'}
        </span>
      )}
      {(reg.prerequisites ?? []).map((p) => <span key={p} className="chip chip-degraded" title="人工前置">人工：{p}</span>)}
      {unsatisfied && <span className="chip chip-error">依赖未满足</span>}
    </div>
  );
}

export interface ModuleCardProps {
  id: ModuleId;
  reg: RegistryModule;
  cap: ModuleCapability;
  caps: CapabilitiesResponse;
  results: readonly LabResultRow[];
  isAdmin: boolean;
}

export function ModuleCard({ id, reg, cap, caps, results, isAdmin }: ModuleCardProps) {
  const [dialog, setDialog] = useState<'switch' | 'ab' | null>(null);
  const summary = reg.lab?.summary;
  const compare = reg.lab?.compare;
  const implemented = id === 'ec2' || MVP_MODULES.includes(id);
  const delta = latestDelta(results);
  const latest = results[0];
  const bypassKeys = cap.bypass ?? reg.bypass ?? [];
  // 只有声明了旁路键（支持运行时 A/B）且已启用的模块才出现“运行 A/B”，且仅管理员
  const canAb = isAdmin && caps.lab.bypassEnabled && bypassKeys.length > 0 && cap.status !== 'off';
  const hourly = reg.lab?.hourlyBilled ?? reg.billing?.some((b) => b.hourly);
  const cardNote = typeof reg.lab?.badges?.['card'] === 'string' ? reg.lab.badges['card'] : null;

  return (
    <article className={`card module-card st-${cap.status} ${implemented ? '' : 'mvp-missing'}`} aria-label={`${id} 模块`}>
      <h3>
        <span>{reg.function}</span>
        <span className="mono subtle">{id}</span>
        <span className="type-mark" title="A = adapter，A·P = 参数型，I = 纯基础设施">{typeMark(reg)}</span>
      </h3>
      <div className="row">
        <ModuleBadge module={id} always />
        <span className="subtle"><span className={`status-dot ${cap.status}`} />{statusText(cap)} · 驱动 <span className="mono">{cap.driver || '—'}</span></span>
      </div>
      <div className="subtle wrap-any" title={cap.detail}>{cap.detail}</div>
      {cardNote && <div className="summary-line"><b>注意</b>{cardNote}</div>}
      {summary?.local && <div className="summary-line"><b>本地</b>{summary.local}</div>}
      {summary?.aws && <div className="summary-line"><b>AWS</b>{summary.aws}</div>}
      {!summary && <div className="summary-line"><b>AWS</b>{reg.awsService}{reg.auxServices.length ? `（辅助：${reg.auxServices.join('、')}）` : ''}</div>}
      <DepChips id={id} reg={reg} cap={cap} caps={caps} />
      <div className="row subtle">
        {compare && <span>对比：{COMPARE_LABEL[compare] ?? compare}</span>}
        {hourly && <span className="badge badge-yellow badge-plain">按小时计费</span>}
        {!implemented && <span className="badge badge-unknown badge-plain">本轮未实现 AWS 适配器</span>}
      </div>
      {delta ? (
        <div className="metric-delta" title="同一实验最新的 before 与 after">{deltaText(delta)}</div>
      ) : latest ? (
        <div className="metric-delta">最近：{latest.experiment} · {latest.label}{latest.forced ? '（forced）' : ''}</div>
      ) : null}
      <div className="row" style={{ marginTop: 'auto' }}>
        {canAb && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog('ab')}>运行 A/B</button>}
        <button type="button" className="btn btn-sm" onClick={() => setDialog('switch')}>如何切换</button>
        <Link className="btn btn-sm" to={`/lab/m/${id}`}>详情</Link>
      </div>
      {dialog === 'switch' && (
        <Dialog title={`如何切换：${id}`} onClose={() => setDialog(null)}>
          <SwitchHowTo id={id} reg={reg} cap={cap} />
        </Dialog>
      )}
      {dialog === 'ab' && (
        <Dialog title={`运行 A/B：${id}`} onClose={() => setDialog(null)}>
          <AbRunner keys={bypassKeys} />
        </Dialog>
      )}
    </article>
  );
}
