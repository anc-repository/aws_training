/**
 * 证书与徽章画面的取值 → 文案（08 P09；04 §10.2、§10.7；tracks §5.5）。
 */
import type { ShapeName, StatusMeta } from '../../ui';

export const REVOKE_REASON_TEXT: Readonly<Record<string, string>> = {
  superseded: '被新证书取代',
  'learner-request': '持有人申请',
  'evidence-invalidated': '依据的证据被判无效',
  'content-defect': '内容缺陷',
  misissued: '误签',
  'key-compromise': '密钥泄露',
  'dependency-revoked': '所依据的旧版证书已被吊销',
};

export function revokeReasonText(r: string | null | undefined): string {
  return r ? (REVOKE_REASON_TEXT[r] ?? '其他原因') : '未说明';
}

/** 422 CERT_NOT_ELIGIBLE 与路径资格的原因（tracks §5.5；platform/api services/catalog/progress.ts）。 */
export function eligibilityReasonText(r: unknown, labTitle?: (labId: string) => string | null): string {
  if (typeof r === 'string') return r;
  const o = (r ?? {}) as { code?: string; labId?: string; groupId?: string; need?: number; have?: number; ratio?: number; min?: number; catalogVersion?: string };
  const lab = (id?: string) => (id ? `${id}${labTitle?.(id) ? `（${labTitle(id)}）` : ''}` : '—');
  switch (o.code) {
    case 'REQUIRED_CARD_MISSING':
      return `必修卡片 ${lab(o.labId)} 还没有有效徽章`;
    case 'BADGE_PENDING':
      return `${lab(o.labId)} 的徽章核验中，结束后才能计入`;
    case 'GROUP_PICK_UNMET':
      return `选修组 ${o.groupId ?? ''} 需要 ${o.need ?? '?'} 张，已完成 ${o.have ?? 0} 张`;
    case 'VERIFIED_RATIO_LOW':
      return `“已核验”占比 ${pct(o.ratio)} 低于要求的 ${pct(o.min)}`;
    case 'CONTENT_DEFECTIVE':
      return `所用的内容版本 ${o.catalogVersion ?? ''} 已被标记为有缺陷`;
    case 'CERTIFICATE_DISABLED':
      return '这条路径不签发证书';
    case 'LAB_CERTIFICATES_DISABLED':
      return '这张卡片不签发证书';
    default:
      return o.code ?? '条件未满足';
  }
}

export function pct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
}

export type TrackCertState = 'not-eligible' | 'eligible' | 'issued' | 'revoked' | 'disabled';

export const TRACK_CERT_META: Readonly<Record<TrackCertState, StatusMeta>> = {
  'not-eligible': { text: '未达成', shape: 'ring', tone: 'faint' },
  eligible: { text: '可领取（条件已满足）', shape: 'half', tone: 'live' },
  issued: { text: '已领取', shape: 'dot', tone: 'pass' },
  revoked: { text: '已吊销', shape: 'xbox', tone: 'fail' },
  disabled: { text: '不签发证书', shape: 'dash', tone: 'mut' },
};

export const BADGE_LEVEL_META: Readonly<Record<string, { text: string; shape: ShapeName }>> = {
  verified: { text: '已核验', shape: 'check' },
  attested: { text: '含手动', shape: 'man' },
  'self-reported': { text: '自述为主', shape: 'q' },
};
