/**
 * Certificate signing key. Production: KMS asymmetric key (ECC_NIST_P256, ECDSA_SHA_256, MessageType=DIGEST).
 * Dev: a local P-256 key file.
 */
export interface EcPublicJwkLike {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface SignerPort {
  /**
   * ES256 signature over SHA-256(`message`), returned in IEEE P1363 `r‖s` form (64 bytes) ready for JWS.
   * Production hashes locally and calls KMS `Sign` with `MessageType=DIGEST`, then converts DER → P1363 (04 §10.3).
   * `keyId` must be a concrete key id (not an alias); the result echoes the key that signed.
   */
  sign(req: { keyId: string; message: Uint8Array }): Promise<{ keyId: string; signature: Uint8Array }>;
  getPublicKey(keyId: string): Promise<{ keyId: string; spkiDer: Uint8Array; jwk: EcPublicJwkLike }>;
}
