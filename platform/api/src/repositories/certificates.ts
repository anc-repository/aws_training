/**
 * `CERT#<certId>`, `CERT#REVOCATIONS` and `KEY#<kid>` (01 §7.2, AP10, AP16, AP27). Written by atl-certs and the
 * `JwksPublish` custom resource; atl-api and atl-public only read. atl-public may only read `CERT#*` / `KEY#*`
 * (`dynamodb:LeadingKeys`), which is all this repository touches.
 */
import { Gsi1, Keys, SkPrefix } from '../data/keys.js';
import type { Item, Table } from './table.js';

export type CertificateItem = Item & { certId: string; sub: string; status: string; kid?: string; jws?: string };
export type SigningKeyItem = Item & { kid: string; jwk?: unknown; publicKeyPem?: string };

const KEYS_PK = Gsi1.signingKey('x').GSI1PK;
const userPk = (sub: string) => Keys.userProfile(sub).PK;
const revocationsPk = Keys.revocationList(0).PK;

export class CertificatesRepo {
  constructor(private readonly table: Table) {}

  async get(certId: string): Promise<CertificateItem | null> {
    return this.table.get<CertificateItem>(Keys.certificate(certId), true);
  }

  /** AP10: my certificates (newest first). */
  async listByUser(sub: string): Promise<CertificateItem[]> {
    return this.table.queryAll<CertificateItem>({ index: 'GSI1', pk: userPk(sub), sk: { beginsWith: SkPrefix.gsi1Cert }, descending: true }, 200);
  }

  async key(kid: string): Promise<SigningKeyItem | null> {
    return this.table.get<SigningKeyItem>(Keys.signingKey(kid));
  }

  /** All signing keys including retired ones. */
  async keys(): Promise<SigningKeyItem[]> {
    return this.table.queryAll<SigningKeyItem>({ index: 'GSI1', pk: KEYS_PK }, 100);
  }

  /** AP27: latest revocation list. */
  async latestRevocations(): Promise<Item | null> {
    const page = await this.table.query({ pk: revocationsPk, sk: { beginsWith: SkPrefix.revocation }, descending: true, limit: 1 });
    return page.items[0] ?? null;
  }
}

/** Reports of a user across sessions (AP10, GSI1 `REPORT#`). */
export async function reportsByUser(table: Table, sub: string): Promise<Item[]> {
  return table.queryAll({ index: 'GSI1', pk: userPk(sub), sk: { beginsWith: SkPrefix.gsi1Report }, descending: true }, 500);
}

/** Experiment runs of a user for a module (AP9, GSI1 `EXP#<module>#`), newest first. */
export async function experimentRunsByUser(table: Table, sub: string, module: string): Promise<Item[]> {
  return table.queryAll({ index: 'GSI1', pk: userPk(sub), sk: { beginsWith: SkPrefix.gsi1Experiment(module) }, descending: true }, 500);
}
