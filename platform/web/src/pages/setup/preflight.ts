/**
 * 平台体检项（08 P00 第 2 步；01 §4.1）：`PlatformConfig.preflight.items[]` → 结论（需处理 / 提示 / 通过 / 无法检测）与说明。
 * 安装时的体检由 platform/infra 的 preflight 自定义资源写入（字段 `{ id, status: ok|warn|info|unknown, detail, hint? }`；
 * 08 §9.2 #3 的写法是 `{ id, status: ok|warn|fail|unknown, message, fix{command?, url?} }`，两种都接受）。
 * 未知 id 显示服务端返回的说明（§9.2 #3 的降级）。
 */
import { msg, withText } from '../../i18n/core';
export interface PreflightItem {
  id: string;
  status: string;
  message?: string;
  detail?: string;
  hint?: string;
  fix?: { command?: string; url?: string } | null;
  resources?: { type?: string; name?: string; role?: string }[];
}

export type Verdict = 'fix' | 'warn' | 'pass' | 'unknown';

/** 这些检查不满足时会让开始实验失败（“需处理”）；其余不满足的是“提示”。 */
const FIX_IDS = new Set(['default-vpc', 'residual-stacks', 'name-conflicts', 'name-conflict']);

export function verdictOf(i: PreflightItem): Verdict {
  if (i.status === 'ok' || i.status === 'pass') return 'pass';
  if (i.status === 'fail') return 'fix';
  if (i.status === 'warn' || i.status === 'info') return FIX_IDS.has(i.id) && i.status === 'warn' ? 'fix' : 'warn';
  return 'unknown';
}

const PFT = msg.frame.preflight;

export const VERDICT_META: Readonly<Record<Verdict, { readonly text: string; shape: 'sq' | 'tri' | 'check' | 'q'; tone: 'fail' | 'drift' | 'pass' | 'needs' }>> = withText(
  {
    fix: { shape: 'sq', tone: 'fail' },
    warn: { shape: 'tri', tone: 'drift' },
    pass: { shape: 'check', tone: 'pass' },
    unknown: { shape: 'q', tone: 'needs' },
  } as const,
  PFT.verdict,
);

export interface PreflightText {
  /** 通过时的一句话（折叠行）。 */
  ok: string;
  /** 需处理 / 提示时的标题。 */
  title: string;
  /** 说明。 */
  body?: string;
  /** 新标签页打开的链接（学员自己的登录）。 */
  link?: { label: string; url: (region: string) => string };
  /** 只复制、不粘贴的命令（此时没有终端）。 */
  command?: (region: string) => string;
  /** 放在“我确认要删除”折叠区内的危险命令。 */
  dangerCommand?: (region: string) => string;
}

const quotas = {
  get label() {
    return PFT.openQuotas;
  },
  url: (r: string) => `https://console.aws.amazon.com/servicequotas/home?region=${encodeURIComponent(r)}`,
};

type PreflightKey = keyof typeof PFT.items;
const item = (key: PreflightKey, extra: Pick<PreflightText, 'link' | 'command' | 'dangerCommand'> = {}): PreflightText => ({
  get ok() {
    return PFT.items[key].ok;
  },
  get title() {
    return PFT.items[key].title;
  },
  get body() {
    return PFT.items[key].body;
  },
  ...extra,
});

export const PREFLIGHT_TEXT: Readonly<Record<string, PreflightText>> = {
  region: item('region'),
  'default-vpc': item('default-vpc', { command: (r) => `aws ec2 create-default-vpc --region ${r}` }),
  'vcpu-quota': item('vcpu-quota', { link: quotas }),
  'existing-trail': item('existing-trail'),
  guardduty: item('guardduty'),
  'config-recorder': item('config-recorder'),
  inspector: item('inspector'),
  'access-analyzer': item('access-analyzer'),
  'ses-sandbox': item('ses-sandbox'),
  organizations: item('organizations'),
  'codebuild-concurrency': item('codebuild-concurrency', { link: quotas }),
  'lambda-concurrency': item('lambda-concurrency', { link: quotas }),
  'residual-stacks': item('residual-stacks', {
    command: (r) => `aws cloudformation list-stacks --region ${r} --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE --query "StackSummaries[?starts_with(StackName,'cloudalbum-')].StackName"`,
    dangerCommand: (r) => `aws cloudformation delete-stack --region ${r} --stack-name ${PFT.stackNamePlaceholder}`,
  }),
  'borrowable-compute': item('borrowable-compute'),
};

export function preflightTitle(i: PreflightItem): string {
  const m = PREFLIGHT_TEXT[i.id];
  if (!m) return i.message ?? i.detail ?? i.id;
  return verdictOf(i) === 'pass' ? m.ok : m.title;
}
