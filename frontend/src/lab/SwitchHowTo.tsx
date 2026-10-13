// “如何切换”：scripts/module enable <id> 命令、硬依赖、凭证与人工前置、是否按小时计费（总纲 8.1 卡片按钮、9.2）。
import type { ModuleCapability, ModuleId, RegistryModule } from '@cloudalbum/contracts';
import { isParamSwitch } from '@cloudalbum/contracts';
import { MVP_MODULES } from '../capabilities/registry';
import { CREDENTIALS_LABEL } from './labUtil';

export function enableCommand(id: ModuleId, reg: RegistryModule): string[] {
  if (id === 'ec2') return ['scripts/module base deploy'];
  const cmds: string[] = [];
  if (reg.credentials === 'required' && id !== 'iam') cmds.push('scripts/module enable iam --mode role');
  if (id === 'iam') cmds.push('scripts/module enable iam --mode role');
  else cmds.push(`scripts/module enable ${id}${reg.requires?.length ? ' --with-deps' : ''}`);
  const sw = reg.switch;
  if (sw && !isParamSwitch(sw) && sw.localTiers.length) {
    for (const tier of sw.localTiers) cmds.push(`scripts/module enable ${id} --driver ${tier}    # 本地档，不部署栈`);
  }
  if (reg.selfHosted) cmds.push(`scripts/module enable ${id} --self-hosted    # 在 EC2 上自建（${reg.selfHosted.installer}）`);
  return cmds;
}

export function SwitchHowTo({ id, reg, cap }: { id: ModuleId; reg: RegistryModule; cap?: ModuleCapability | undefined }) {
  const enabled = cap ? cap.status !== 'off' : false;
  const hardDeps = [...new Set((reg.requires ?? []).flatMap((r) => r.need))];
  const hourly = reg.lab?.hourlyBilled ?? reg.billing?.some((b) => b.hourly);
  const implemented = id === 'ec2' || MVP_MODULES.includes(id);
  return (
    <div className="stack">
      {!implemented && (
        <p className="notice notice-warn">本轮（MVP）还没有实现这个模块的 AWS 适配器：启用后应用启动时会以退出码 78 拒绝（CFG-001）。</p>
      )}
      <pre aria-label="命令"><code>{enabled ? `scripts/module disable ${id}\nscripts/module status ${id}` : enableCommand(id, reg).join('\n')}</code></pre>
      {cap?.switch && (
        <p className="subtle">开关：<span className="mono">{cap.switch.var}</span> = <span className="mono">{cap.switch.value || '（空）'}</span>（本地取值 <span className="mono">{cap.switch.localValue || '（空）'}</span>）</p>
      )}
      <dl className="kv">
        <dt>硬依赖</dt>
        <dd>{hardDeps.length ? hardDeps.map((d) => <code key={d} style={{ marginRight: 6 }}>{d}</code>) : '无'}</dd>
        <dt>凭证</dt><dd>{CREDENTIALS_LABEL[reg.credentials] ?? reg.credentials}</dd>
        <dt>人工前置</dt><dd>{reg.prerequisites?.length ? reg.prerequisites.join('、') : '无'}</dd>
        <dt>计费</dt>
        <dd>
          {hourly ? <strong>按小时计费，练完记得 disable。</strong> : '按用量计费（或免费额度内）。'}
          {reg.billing?.length ? <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{reg.billing.map((b) => <li key={b.resource}>{b.resource}（{b.dimension === 'hour' ? '按小时' : b.dimension === 'request' ? '按请求' : '按用量'}）</li>)}</ul> : null}
          <span className="subtle">金额以 AWS 官方定价页为准（本项目不写单价）。</span>
        </dd>
        <dt>文档</dt><dd className="mono wrap-any">{reg.doc}</dd>
      </dl>
    </div>
  );
}
