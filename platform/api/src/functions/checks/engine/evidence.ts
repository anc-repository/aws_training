/**
 * Evidence envelopes `atl.evidence/v1` (04 §5.5): RFC 8785 canonical form, SHA-256 digest, inline when ≤ 4 KB, otherwise
 * stored at `atl-data/evidence/<sid>/<runId>/<checkKey>.json` with only the digest and key in `CheckRun.results[]`.
 */
import { canonicalJson, DataKeys } from '@atl/shared';
import { sha256Hex } from '@atl/shared/node';
import type { CheckDecl, EvidenceEnvelope } from '../types.js';

export const INLINE_EVIDENCE_LIMIT = 4096;

export function sha256Tagged(s: string | Uint8Array): string {
  return `sha256:${sha256Hex(s)}`;
}

/** `checkHash` = SHA-256 of the canonical expanded check definition. */
export function checkHash(decl: CheckDecl): string {
  return sha256Tagged(canonicalJson(decl));
}

/** Seal an envelope: compute `digest` over the canonical form without `digest`. */
export function sealEvidence(e: Omit<EvidenceEnvelope, 'digest'>): EvidenceEnvelope {
  const body = JSON.parse(JSON.stringify(e)) as Omit<EvidenceEnvelope, 'digest'>;
  return { ...body, digest: sha256Tagged(canonicalJson(body)) };
}

export function verifyEvidenceDigest(e: EvidenceEnvelope): boolean {
  const { digest, ...rest } = e;
  return digest === sha256Tagged(canonicalJson(rest));
}

export function evidenceSize(e: EvidenceEnvelope): number {
  return Buffer.byteLength(JSON.stringify(e), 'utf8');
}

export function evidenceObjectKey(sid: string, runId: string, checkKey: string): string {
  return DataKeys.evidence(sid, runId, checkKey);
}
