/**
 * 证书与徽章画面的取值 → 文案（08 P09；04 §10.2、§10.7；tracks §5.5）。
 */
import type { ShapeName, StatusMeta } from '../../ui';

import { t, withText } from '../../i18n';
import { CT } from './strings';
const V = CT.values;

export const REVOKE_REASON_TEXT: Readonly<Record<string, string>> = V.revokeReason;

export function revokeReasonText(r: string | null | undefined): string {
  return r ? (REVOKE_REASON_TEXT[r] ?? V.otherReason) : V.unspecified;
}

/** 422 CERT_NOT_ELIGIBLE 与路径资格的原因（tracks §5.5；platform/api services/catalog/progress.ts）。 */
export function eligibilityReasonText(r: unknown, labTitle?: (labId: string) => string | null): string {
  if (typeof r === 'string') return r;
  const o = (r ?? {}) as { code?: string; labId?: string; groupId?: string; need?: number; have?: number; ratio?: number; min?: number; catalogVersion?: string };
  const lab = (id?: string) => (id ? (labTitle?.(id) ? t(V.labWithTitle, { id, title: labTitle(id) }) : id) : '—');
  switch (o.code) {
    case 'REQUIRED_CARD_MISSING':
      return t(V.requiredMissing, { lab: lab(o.labId) });
    case 'BADGE_PENDING':
      return t(V.badgePending, { lab: lab(o.labId) });
    case 'GROUP_PICK_UNMET':
      return t(V.groupUnmet, { group: o.groupId ?? '', need: o.need ?? '?', have: o.have ?? 0 });
    case 'VERIFIED_RATIO_LOW':
      return t(V.ratioLow, { ratio: pct(o.ratio), min: pct(o.min) });
    case 'CONTENT_DEFECTIVE':
      return t(V.defective, { v: o.catalogVersion ?? '' });
    case 'CERTIFICATE_DISABLED':
      return V.trackDisabled;
    case 'LAB_CERTIFICATES_DISABLED':
      return V.labDisabled;
    default:
      return o.code ?? V.unmet;
  }
}

export function pct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
}

export type TrackCertState = 'not-eligible' | 'eligible' | 'issued' | 'revoked' | 'disabled';

export const TRACK_CERT_META: Readonly<Record<TrackCertState, StatusMeta>> = withText(
  {
    'not-eligible': { shape: 'ring', tone: 'faint' },
    eligible: { shape: 'half', tone: 'live' },
    issued: { shape: 'dot', tone: 'pass' },
    revoked: { shape: 'xbox', tone: 'fail' },
    disabled: { shape: 'dash', tone: 'mut' },
  },
  V.trackCert,
);

export const BADGE_LEVEL_META: Readonly<Record<string, { readonly text: string; shape: ShapeName }>> = withText(
  {
    verified: { shape: 'check' as ShapeName },
    attested: { shape: 'man' as ShapeName },
    'self-reported': { shape: 'q' as ShapeName },
  },
  V.badgeLevel,
);
