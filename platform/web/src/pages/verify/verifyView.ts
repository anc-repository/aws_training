/**
 * 公开验证页（P09-V）的结果呈现：把验证结果映射为 08 P09-V 表中的 12 种结果（形状 + 文字 + 颜色），纯函数，便于表驱动测试。
 * 文案按 08 §1.6：不出现接口名、事件名等实现细节；只在签名通过后才显示载荷中的内容（未通过验签的内容可能是伪造的）。
 */
import { redactText } from '../share/publicRedact';
import { certLabs, type CertLab, type CertPayload, type VerifyOutcome } from './verifyCore';

export type VerifyTone = 'ok' | 'bad' | 'warn' | 'grey' | 'pend';
export type VerifyShape = 'check' | 'xbox' | 'tri' | 'ring' | 'clock';

export type PageResult =
  | { kind: 'verifying' }
  | { kind: 'no-input' }
  | { kind: 'not-public'; certId: string }
  | { kind: 'unsupported' }
  | { kind: 'network' }
  | { kind: 'outcome'; outcome: VerifyOutcome; rollback: { seen: number; got: number } | null };

export interface ResultCard {
  /** 结果的稳定标识（测试与 data-result）。 */
  id: string;
  tone: VerifyTone;
  shape: VerifyShape;
  title: string;
  detail: string;
  /** 显示“粘贴证书”。 */
  paste: boolean;
  /** 显示“重试”。 */
  retry: boolean;
}

export const REVOKE_REASON_TEXT: Readonly<Record<string, string>> = {
  superseded: '被新证书取代',
  'learner-request': '持有人申请',
  'evidence-invalidated': '依据的证据被判无效',
  'content-defect': '内容缺陷',
  misissued: '误签',
  'key-compromise': '密钥泄露',
  'dependency-revoked': '所依据的旧版证书已被吊销',
};

export const BADGE_LEVEL_TEXT: Readonly<Record<string, string>> = {
  verified: '已核验',
  attested: '含手动',
  'self-reported': '自述为主',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** 日期 `2026-10-20`（本地时区）。 */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 悬停显示的 UTC 时间。 */
export function utcTitle(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '';
}

export function revokeReasonText(reason: string | null | undefined): string {
  if (!reason) return '未说明';
  return REVOKE_REASON_TEXT[reason] ?? '其他原因';
}

export function resultCard(r: PageResult): ResultCard {
  const base = { paste: false, retry: false };
  switch (r.kind) {
    case 'verifying':
      return { ...base, id: 'verifying', tone: 'pend', shape: 'clock', title: '正在验证签名…', detail: '' };
    case 'no-input':
      return { ...base, id: 'no-input', tone: 'grey', shape: 'ring', title: '粘贴证书以验证', detail: '把持有人提供的证书（JWS）粘贴到下面，或选择证书文件。验证完全在你的浏览器中完成。', paste: true };
    case 'not-public':
      return { ...base, id: 'not-public', tone: 'grey', shape: 'ring', title: '该证书未公开', detail: '请使用持有人提供的证书文件，或带 #jws= 的链接。', paste: true };
    case 'unsupported':
      return { ...base, id: 'unsupported', tone: 'warn', shape: 'tri', title: '你的浏览器不支持本地验签', detail: '请换用新版浏览器，或使用离线验证包中的脚本。' };
    case 'network':
      return { ...base, id: 'network', tone: 'grey', shape: 'xbox', title: '无法读取公钥（网络错误）', detail: '', retry: true };
    case 'outcome':
      return outcomeCard(r.outcome, r.rollback);
  }
}

function outcomeCard(o: VerifyOutcome, rollback: { seen: number; got: number } | null): ResultCard {
  const base = { paste: false, retry: false };
  switch (o.status) {
    case 'valid':
      if (o.revocations.state === 'unavailable' || o.revocations.state === 'invalid') {
        return { ...base, id: 'revocations-unavailable', tone: 'warn', shape: 'tri', title: '签名有效 · 无法确认吊销状态', detail: '吊销列表暂不可用。' };
      }
      if (rollback) {
        return { ...base, id: 'revocations-rollback', tone: 'warn', shape: 'tri', title: '签名有效 · 吊销列表可能是旧版本', detail: `序号 ${rollback.got} < ${rollback.seen}（本浏览器见过更新的列表）。` };
      }
      return { ...base, id: 'valid', tone: 'ok', shape: 'check', title: '签名有效', detail: '' };
    case 'revoked': {
      const e = o.revocations.entry;
      const reason = e?.reason ?? null;
      const tail = e?.revokedAt ? ` · 吊销于 ${formatDay(e.revokedAt)}` : '';
      return { ...base, id: 'revoked', tone: 'bad', shape: 'xbox', title: '已吊销', detail: `原因：${revokeReasonText(reason)}${reason ? `（${reason}）` : ''}${tail}` };
    }
    case 'invalid-signature':
      return { ...base, id: 'invalid-signature', tone: 'bad', shape: 'xbox', title: '签名无效', detail: '内容被修改，或不是本实例签发。' };
    case 'unknown-key':
      return { ...base, id: 'unknown-key', tone: 'warn', shape: 'tri', title: '未知签名密钥', detail: '证书可能来自另一个 ATL 实例，或密钥已被移除。' };
    case 'key-not-valid':
      return { ...base, id: 'key-not-valid', tone: 'bad', shape: 'xbox', title: '签发时间不在该密钥的有效期内', detail: '' };
    case 'origin-mismatch':
      return { ...base, id: 'origin-mismatch', tone: 'bad', shape: 'xbox', title: '签发源不符', detail: '证书声明的签发实例与本站不一致。' };
    case 'malformed':
      return { ...base, id: 'malformed', tone: 'bad', shape: 'xbox', title: '这不是有效的 ATL 证书', detail: '不是三段式 JWS、签名算法或类型不符，或证书内容的格式不符。', paste: true };
  }
}

/** 签名通过（有效或已吊销）时才展示载荷内容。 */
export function showsPayload(r: PageResult): boolean {
  return r.kind === 'outcome' && (r.outcome.status === 'valid' || r.outcome.status === 'revoked');
}

export interface DetailRow {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}

function pct(v: number | null | undefined): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : null;
}

function short(s: string | null | undefined, n: number): string {
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 证书详情（已打码）：证书、持有人、签发实例、吊销列表。 */
export function detailRows(p: CertPayload, o: VerifyOutcome, rollback: { seen: number; got: number } | null): DetailRow[] {
  const red = (s: string | null | undefined) => redactText(s ?? '', 'standard');
  const a = p.achievement ?? {};
  const scope = a.trackId ? `${red(a.trackId)}${a.trackVersion ? ` v${red(a.trackVersion)}` : ''}` : a.labId ? `${red(a.labId)}${a.labVersion ? ` v${red(a.labVersion)}` : ''}` : '';
  const ratio = pct(a.verifiedRatio ?? null);
  const rows: DetailRow[] = [
    { label: '证书', value: `${red(p.certId)}${a.title ? ` · ${red(a.title)}` : ''}${scope ? `（${scope}）` : ''}`, mono: false },
    {
      label: '持有人',
      value: `${red(p.subject?.displayName) || '—'} · 签发于 ${formatDay(p.issuedAt)}${ratio ? ` · “已核验”占比 ${ratio}` : ''}`,
      title: utcTitle(p.issuedAt),
    },
    {
      label: '签发实例',
      value: `${red(p.issuer?.origin) || '—'} · 安装 ${short(red(p.issuer?.installId), 8)} · 公钥指纹 ${short(o.key?.kid ?? p.issuer?.kid, 8)}`,
      title: o.key?.kid ? `公钥指纹（kid）：${o.key.kid}` : undefined,
    },
  ];
  let rev: string;
  if (o.status === 'revoked') rev = `已吊销（列表序号 ${o.revocations.seq ?? '—'}，签名有效）`;
  else if (o.revocations.state === 'checked') rev = rollback ? `可能是旧版本（序号 ${rollback.got} < ${rollback.seen}）` : `未吊销（列表序号 ${o.revocations.seq ?? '—'}，签名有效）`;
  else rev = '无法确认（吊销列表暂不可用）';
  rows.push({ label: '吊销列表', value: rev });
  return rows;
}

export interface LabRow {
  labId: string;
  text: string;
  digest: string | null;
}

/** 包含的卡片：卡片与版本 · 徽章等级 · 自动 / 手动 · 报告摘要（前 8 位）。 */
export function labRows(p: CertPayload): LabRow[] {
  return certLabs(p).map((l: CertLab) => {
    const red = (s: string | null | undefined) => redactText(s ?? '', 'standard');
    const parts = [`${red(l.labId)}${l.labVersion ? ` v${red(l.labVersion)}` : ''}`];
    if (l.badgeLevel) parts.push(BADGE_LEVEL_TEXT[l.badgeLevel] ?? red(l.badgeLevel));
    if (l.checks) parts.push(`自动 ${l.checks.auto ?? 0} / 手动 ${l.checks.manual ?? 0}`);
    parts.push(l.reportDigest ? `报告摘要 ${l.reportDigest.slice(0, 15)}…` : '没有报告摘要');
    return { labId: l.labId, text: parts.join(' · '), digest: l.reportDigest ?? null };
  });
}
