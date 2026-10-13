/**
 * Admin initial password (02 §4.3 base-deploy step 6, 06 PM-07): a random password whose plaintext only goes to the
 * SecureString parameter, and its argon2id PHC string — the only thing sent to the instance. Parameters equal the
 * application's own (`ARGON2_PARAMS` of the backend: m=19456 KiB, t=2, p=1), never lower.
 */
import { randomBytes } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2';

export const ADMIN_ARGON2 = { m: 19456, t: 2, p: 1, dkLen: 32 } as const;

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/=+$/, '');

/** 24 characters with upper, lower, digit and symbol (also valid for Cognito's default policy). */
export function randomPassword(length = 24): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+-.=?@^_'];
  const all = sets.join('');
  const pick = (alphabet: string) => alphabet[randomBytes(1)[0]! % alphabet.length]!;
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates with crypto randomness
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export function argon2idPhc(password: string, salt: Uint8Array = randomBytes(16), params = ADMIN_ARGON2): string {
  const hash = argon2id(new TextEncoder().encode(password), salt, { m: params.m, t: params.t, p: params.p, dkLen: params.dkLen });
  return `$argon2id$v=19$m=${params.m},t=${params.t},p=${params.p}$${b64(salt)}$${b64(hash)}`;
}
