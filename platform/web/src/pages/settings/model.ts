/**
 * P12 的纯函数（08 §4 P12），测试见 settings.test.ts：页签与角色、卸载中只读、平台设置表单 ⇄ PATCH /settings 补丁、
 * 待人工处理清单的 Markdown / JSON 导出、卸载阻塞项。
 */
import type { Role } from '../../auth/jwt';
import type { ManualResource } from '../../api/types';

import { msg, t } from '../../i18n';

const ME = msg.pages.manualExport;
export type SettingsTab = 'profile' | 'platform' | 'guardrails' | 'workspace' | 'members' | 'content' | 'audit' | 'upgrade' | 'uninstall';

export const SETTINGS_TABS: readonly { id: SettingsTab; roles: readonly Role[] }[] = [
  { id: 'profile', roles: ['L', 'A', 'O'] },
  { id: 'platform', roles: ['L'] },
  { id: 'guardrails', roles: ['L'] },
  { id: 'workspace', roles: ['L'] },
  { id: 'members', roles: ['L'] },
  { id: 'content', roles: ['L'] },
  { id: 'audit', roles: ['L', 'A'] },
  { id: 'upgrade', roles: ['L'] },
  { id: 'uninstall', roles: ['L'] },
];

export function isSettingsTab(v: string | undefined): v is SettingsTab {
  return SETTINGS_TABS.some((x) => x.id === v);
}

export function allowedTabs(role: Role | null): SettingsTab[] {
  return SETTINGS_TABS.filter((x) => role && x.roles.includes(role)).map((x) => x.id);
}

/** 卸载中：除 uninstall、profile、audit 外的页签只读（08 P12“状态”）。 */
export function readOnlyTab(tab: SettingsTab, uninstalling: boolean): boolean {
  return uninstalling && !['uninstall', 'profile', 'audit'].includes(tab);
}

// ---------------------------------------------------------------------------------------------------------------
// 平台设置（GET /settings ⇄ PATCH /settings）

export interface SettingsView {
  ver: number | null;
  limits?: { readyIdleMinutes?: number; envMaxAgeDays?: number; maxKeepHours?: number; maxSessionMinutes?: number; extension?: { minutes?: number; maxCount?: number } } | null;
  reclaim?: { blockStartOnResidual?: 'ack' | 'block' | 'ignore' } | null;
  ownership?: { maxWaitMinutes?: number } | null;
  terminal?: { persistence?: string; streamUrlSigning?: string; keepalive?: number; recording?: string } | null;
  console?: { longSession?: boolean } | null;
  preview?: { directHttps?: 'letsencrypt-ip' | 'off' } | null;
  agent?: { lateUploadFallback?: 'on' | 'off' } | null;
  workstation?: { instanceType?: string } | null;
  [k: string]: unknown;
}

export interface SettingsForm {
  readyIdleMinutes: string;
  maxKeepHours: string;
  maxSessionMinutes: string;
  extMinutes: string;
  extCount: string;
  persistence: string;
  streamUrlSigning: string;
  keepalive: string;
  longSession: boolean;
  directHttps: string;
  lateUploadFallback: string;
  blockStartOnResidual: string;
  maxWaitMinutes: string;
}

const num = (v: number | undefined | null) => (typeof v === 'number' ? String(v) : '');

export function formFromSettings(s: SettingsView | null): SettingsForm {
  return {
    readyIdleMinutes: num(s?.limits?.readyIdleMinutes),
    maxKeepHours: num(s?.limits?.maxKeepHours),
    maxSessionMinutes: num(s?.limits?.maxSessionMinutes),
    extMinutes: num(s?.limits?.extension?.minutes),
    extCount: num(s?.limits?.extension?.maxCount),
    persistence: s?.terminal?.persistence ?? '',
    streamUrlSigning: s?.terminal?.streamUrlSigning ?? '',
    keepalive: num(s?.terminal?.keepalive),
    longSession: s?.console?.longSession === true,
    directHttps: s?.preview?.directHttps ?? '',
    lateUploadFallback: s?.agent?.lateUploadFallback ?? '',
    blockStartOnResidual: s?.reclaim?.blockStartOnResidual ?? 'ack',
    maxWaitMinutes: num(s?.ownership?.maxWaitMinutes),
  };
}

/** 表单字段 → PATCH 的路径（服务端字段级错误的 path 用同一个写法）。 */
export const FIELD_PATH: Readonly<Record<keyof SettingsForm, string>> = {
  readyIdleMinutes: 'limits.readyIdleMinutes',
  maxKeepHours: 'limits.maxKeepHours',
  maxSessionMinutes: 'limits.maxSessionMinutes',
  extMinutes: 'limits.extension.minutes',
  extCount: 'limits.extension.maxCount',
  persistence: 'terminal.persistence',
  streamUrlSigning: 'terminal.streamUrlSigning',
  keepalive: 'terminal.keepalive',
  longSession: 'console.longSession',
  directHttps: 'preview.directHttps',
  lateUploadFallback: 'agent.lateUploadFallback',
  blockStartOnResidual: 'reclaim.blockStartOnResidual',
  maxWaitMinutes: 'ownership.maxWaitMinutes',
};

const NUMERIC: ReadonlySet<keyof SettingsForm> = new Set(['readyIdleMinutes', 'maxKeepHours', 'maxSessionMinutes', 'extMinutes', 'extCount', 'keepalive', 'maxWaitMinutes']);

export interface PatchResult {
  patch: Record<string, unknown>;
  errors: Partial<Record<keyof SettingsForm, string>>;
}

/** 只提交变化的字段；数字字段必须是非负整数。 */
export function settingsPatch(before: SettingsForm, after: SettingsForm): PatchResult {
  const patch: Record<string, unknown> = {};
  const errors: PatchResult['errors'] = {};
  for (const k of Object.keys(FIELD_PATH) as (keyof SettingsForm)[]) {
    if (before[k] === after[k]) continue;
    let value: unknown = after[k];
    if (NUMERIC.has(k)) {
      const s = String(after[k]).trim();
      if (!/^\d{1,6}$/.test(s)) {
        errors[k] = ME.nonNegative;
        continue;
      }
      value = Number(s);
    } else if (typeof value === 'string' && !value) continue;
    const path = FIELD_PATH[k].split('.');
    let node = patch;
    for (const seg of path.slice(0, -1)) node = (node[seg] ??= {}) as Record<string, unknown>;
    node[path[path.length - 1]!] = value;
  }
  return { patch, errors };
}

/** 服务端 `VALIDATION_FAILED` 的 errors[{path, message}] → 表单字段。 */
export function fieldErrorsFrom(errors: readonly { path: string; message: string }[]): Partial<Record<keyof SettingsForm, string>> {
  const out: Partial<Record<keyof SettingsForm, string>> = {};
  for (const e of errors) {
    const k = (Object.keys(FIELD_PATH) as (keyof SettingsForm)[]).find((x) => FIELD_PATH[x] === e.path);
    if (k) out[k] = e.message;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 待人工处理清单的导出（浏览器内生成，不经服务端）

type Manual = ManualResource & { envId?: string; manualHint?: { consoleUrl?: string; cli?: string; note?: string } | null };

export function manualMarkdown(items: readonly Manual[], at: string): string {
  const lines = [ME.title, '', t(ME.exportedAt, { t: at }), '', t(ME.count, { n: items.length }), ''];
  items.forEach((m, i) => {
    lines.push(`## ${i + 1}. ${m.resourceType} ${m.name ?? m.arn ?? m.resourceKey}`);
    lines.push('');
    if (m.arn) lines.push(t(ME.arn, { v: `\`${m.arn}\`` }));
    if (m.region) lines.push(t(ME.region, { v: m.region }));
    if (m.severity) lines.push(t(ME.severity, { v: m.severity }));
    if (m.billing) lines.push(t(ME.billing, { v: m.billing }));
    if (m.sessionId) lines.push(m.labId ? t(ME.sessionLab, { v: m.sessionId, lab: m.labId }) : t(ME.session, { v: m.sessionId }));
    const hint = m.manualHint;
    if (hint?.consoleUrl) lines.push(t(ME.console, { v: hint.consoleUrl }));
    if (hint?.note) lines.push(t(ME.note, { v: hint.note }));
    if (hint?.cli) lines.push('', '```bash', hint.cli, '```');
    lines.push('');
  });
  return lines.join('\n');
}

export function manualJson(items: readonly Manual[], at: string): string {
  return JSON.stringify({ schema: 'atl.manual-resources/v1', exportedAt: at, items }, null, 2);
}

// ---------------------------------------------------------------------------------------------------------------
// 卸载状态（GET /platform/uninstall/status）

export interface UninstallStatus {
  ready: boolean;
  mode: string;
  terminationProtection: boolean | null;
  blockers: { code: string; sessionId?: string; state?: string; labId?: string; count?: number; until?: string; link?: string }[];
  followUps?: { sessionId: string; revokedAt: string | null }[];
  rescanWarning: string | null;
  serverNow?: string;
}

/** 第 3 步（删除平台栈）只在全部阻塞项解除、且终止保护已关闭后出现（08 P12）。 */
export function canDeleteStack(s: UninstallStatus | null): boolean {
  return !!s && s.ready && s.terminationProtection === false;
}
