/**
 * 公开验证页（P09-V）的结果呈现：把验证结果映射为 08 P09-V 表中的 12 种结果（形状 + 文字 + 颜色），纯函数，便于表驱动测试。
 * 文案按 08 §1.6：不出现接口名、事件名等实现细节；只在签名通过后才显示载荷中的内容（未通过验签的内容可能是伪造的）。
 */
import { redactText } from '../share/publicRedact';
import { certLabs, type CertLab, type CertPayload, type VerifyOutcome } from './verifyCore';

import { INTL_TAG, type Locale } from '../../i18n/locale';
import { t } from '../../i18n/text';
import { VT, verifyLocale } from './strings';
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

export const REVOKE_REASON_TEXT: Readonly<Record<string, string>> = VT.revokeReason;

export const BADGE_LEVEL_TEXT: Readonly<Record<string, string>> = VT.badgeLevel;

const R = VT.result;
const D = VT.detail;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 日期（本地时区，09 §1.4）：zh-CN `2026-10-20`；ja / en 用 Intl（`2026/10/20`、`Oct 20, 2026`），与 SPA 的 fmtDay 相同。
 * 验证页不加载 SPA 的运行时，语言取验证页自己的选择。
 */
export function formatDay(iso: string | null | undefined, lang: Locale = verifyLocale()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  if (lang === 'zh-CN') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return new Intl.DateTimeFormat(INTL_TAG[lang], { year: 'numeric', month: lang === 'en' ? 'short' : '2-digit', day: '2-digit' }).format(d);
}

const HAN = /[\u3400-\u9fff]/;
const KANA = /[\u3040-\u30ff]/;

/** 悬停显示的 UTC 时间。 */
export function utcTitle(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '';
}

export function revokeReasonText(reason: string | null | undefined): string {
  if (!reason) return VT.unspecified;
  return REVOKE_REASON_TEXT[reason] ?? VT.otherReason;
}

export function resultCard(r: PageResult): ResultCard {
  const base = { paste: false, retry: false };
  switch (r.kind) {
    case 'verifying':
      return { ...base, id: 'verifying', tone: 'pend', shape: 'clock', title: R.verifying, detail: '' };
    case 'no-input':
      return { ...base, id: 'no-input', tone: 'grey', shape: 'ring', title: R.noInput, detail: R.noInputDetail, paste: true };
    case 'not-public':
      return { ...base, id: 'not-public', tone: 'grey', shape: 'ring', title: R.notPublic, detail: R.notPublicDetail, paste: true };
    case 'unsupported':
      return { ...base, id: 'unsupported', tone: 'warn', shape: 'tri', title: R.unsupported, detail: R.unsupportedDetail };
    case 'network':
      return { ...base, id: 'network', tone: 'grey', shape: 'xbox', title: R.network, detail: '', retry: true };
    case 'outcome':
      return outcomeCard(r.outcome, r.rollback);
  }
}

function outcomeCard(o: VerifyOutcome, rollback: { seen: number; got: number } | null): ResultCard {
  const base = { paste: false, retry: false };
  switch (o.status) {
    case 'valid':
      if (o.revocations.state === 'unavailable' || o.revocations.state === 'invalid') {
        return { ...base, id: 'revocations-unavailable', tone: 'warn', shape: 'tri', title: R.revUnavailable, detail: R.revUnavailableDetail };
      }
      if (rollback) {
        return { ...base, id: 'revocations-rollback', tone: 'warn', shape: 'tri', title: R.revRollback, detail: t(R.revRollbackDetail, { got: rollback.got, seen: rollback.seen }) };
      }
      return { ...base, id: 'valid', tone: 'ok', shape: 'check', title: R.valid, detail: '' };
    case 'revoked': {
      const e = o.revocations.entry;
      const reason = e?.reason ?? null;
      const tail = e?.revokedAt ? t(R.revokedAt, { t: formatDay(e.revokedAt) }) : '';
      return { ...base, id: 'revoked', tone: 'bad', shape: 'xbox', title: R.revoked, detail: `${t(R.revokedReason, { reason: revokeReasonText(reason) })}${reason ? t(R.revokedCode, { code: reason }) : ''}${tail}` };
    }
    case 'invalid-signature':
      return { ...base, id: 'invalid-signature', tone: 'bad', shape: 'xbox', title: R.invalidSignature, detail: R.invalidSignatureDetail };
    case 'unknown-key':
      return { ...base, id: 'unknown-key', tone: 'warn', shape: 'tri', title: R.unknownKey, detail: R.unknownKeyDetail };
    case 'key-not-valid':
      return { ...base, id: 'key-not-valid', tone: 'bad', shape: 'xbox', title: R.keyNotValid, detail: '' };
    case 'origin-mismatch':
      return { ...base, id: 'origin-mismatch', tone: 'bad', shape: 'xbox', title: R.originMismatch, detail: R.originMismatchDetail };
    case 'malformed':
      return { ...base, id: 'malformed', tone: 'bad', shape: 'xbox', title: R.malformed, detail: R.malformedDetail, paste: true };
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
  /**
   * 值的一部分是签发时记录的中文（证书标题）：页面把它放进 `<span lang="zh-CN">` 并加“未翻訳”标记（WCAG 3.1.2、I2）。
   * `value` 仍是完整的纯文本。
   */
  segments?: { text: string; lang?: Locale; untranslated?: boolean }[];
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
  // 证书标题是签发时写入的源语言（zh-CN）文字：界面是其他语言时标出语言与“未翻訳”
  const title = a.title ? red(a.title) : '';
  const foreign = !!title && verifyLocale() !== 'zh-CN' && HAN.test(title) && !KANA.test(title);
  const certValue = `${red(p.certId)}${title ? ` · ${title}` : ''}${scope ? t(D.scope, { scope }) : ''}`;
  const rows: DetailRow[] = [
    {
      label: D.cert,
      value: certValue,
      mono: false,
      ...(foreign
        ? { segments: [{ text: `${red(p.certId)} · ` }, { text: title, lang: 'zh-CN' as const, untranslated: true }, ...(scope ? [{ text: t(D.scope, { scope }) }] : [])] }
        : {}),
    },
    {
      label: D.holder,
      value: `${t(D.holderValue, { name: red(p.subject?.displayName) || '—', t: formatDay(p.issuedAt) })}${ratio ? t(D.ratio, { ratio }) : ''}`,
      title: utcTitle(p.issuedAt),
    },
    {
      label: D.issuer,
      value: t(D.issuerValue, { origin: red(p.issuer?.origin) || '—', install: short(red(p.issuer?.installId), 8), kid: short(o.key?.kid ?? p.issuer?.kid, 8) }),
      title: o.key?.kid ? t(D.kidTitle, { kid: o.key.kid }) : undefined,
    },
  ];
  let rev: string;
  if (o.status === 'revoked') rev = t(D.revRevoked, { seq: o.revocations.seq ?? '—' });
  else if (o.revocations.state === 'checked') rev = rollback ? t(D.revRollback, { got: rollback.got, seen: rollback.seen }) : t(D.revOk, { seq: o.revocations.seq ?? '—' });
  else rev = D.revUnknown;
  rows.push({ label: D.revocations, value: rev });
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
    if (l.checks) parts.push(t(D.checks, { auto: l.checks.auto ?? 0, manual: l.checks.manual ?? 0 }));
    parts.push(l.reportDigest ? t(D.digest, { d: l.reportDigest.slice(0, 15) }) : D.noDigest);
    return { labId: l.labId, text: parts.join(' · '), digest: l.reportDigest ?? null };
  });
}
