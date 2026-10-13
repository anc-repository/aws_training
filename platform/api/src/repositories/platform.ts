/**
 * Singletons of the `PLATFORM` and `CATALOG` partitions (01 §7.2, AP1, AP2): `PlatformConfig`, `ActiveEnvironmentLock`
 * and `CatalogRelease`.
 *
 * The lock operations implement 02 §3.4 / §9.2 as conditional writes:
 *  - `acquire`: free lock (or already ours) → `holderEnvId`, `holderSessionId`, `acquiredAt`;
 *  - `reserve`: lock held by the KEPT environment E → `pendingSessionId`, `pendingUntil` (no hand-over yet);
 *  - `transferTx`: the `TransactWriteItems` member that moves the lock to the reserving session in `EnterProvisioning`
 *    (same transaction as T15 + T02);
 *  - `release`: in `Conclude`, only by the holder.
 * There is no time-based expiry of the lock itself; only a reservation has `pendingUntil`.
 * `atl-api` only reads the lock (non-authoritative fast check, 01 §7.5 item 1); `atl-lifecycle` writes it.
 */
import type { ActiveEnvironmentLockItem, PlatformConfigItem } from '@atl/shared';
import { Keys } from '../data/keys.js';
import { isConditionFailed, type Item, type Table } from './table.js';
import { txUpdate, type TransactItem } from './transactions.js';

export type PlatformConfig = PlatformConfigItem & Item & { ver: number };
export type LockItem = ActiveEnvironmentLockItem & Item;
export type CatalogReleaseItem = Item & { catalogVersion: string; contentDigest?: string; defective?: boolean | { at: string; by: string; reason?: string } };

export class LockBusyError extends Error {
  constructor(
    message: string,
    readonly lock: LockItem | null,
  ) {
    super(message);
    this.name = 'Atl.LockBusy';
  }
}

export class PlatformRepo {
  constructor(private readonly table: Table) {}

  /** AP1. */
  async config(consistent = false): Promise<PlatformConfig | null> {
    return this.table.get<PlatformConfig>(Keys.platformConfig(), consistent);
  }

  /** Settings written by atl-api (`PATCH /settings`, maintenance), optimistic on `ver`. */
  async updateConfig(set: Record<string, unknown>, expectedVer: number | undefined, nowIso: string): Promise<PlatformConfig> {
    return this.table.update<PlatformConfig>(Keys.platformConfig(), {
      set: { ...set, updatedAt: nowIso },
      add: { ver: 1 },
      condition:
        expectedVer === undefined
          ? { expression: 'attribute_exists(PK)' }
          : { expression: 'attribute_exists(PK) AND #v = :v', names: { '#v': 'ver' }, values: { ':v': expectedVer } },
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // ActiveEnvironmentLock

  /** AP2 (strongly consistent). */
  async lock(): Promise<LockItem | null> {
    return this.table.get<LockItem>(Keys.activeEnvironmentLock(), true);
  }

  /** Free lock (or one already held by `sid`) → held by `sid` / `envId`. */
  async acquire(sid: string, envId: string, nowIso: string): Promise<LockItem> {
    try {
      return await this.table.update<LockItem>(Keys.activeEnvironmentLock(), {
        set: { type: 'ActiveEnvironmentLock', holderEnvId: envId, holderSessionId: sid, acquiredAt: nowIso, updatedAt: nowIso },
        remove: ['pendingSessionId', 'pendingUntil'],
        add: { ver: 1 },
        condition: {
          expression: 'attribute_not_exists(holderSessionId) OR holderSessionId = :sid',
          values: { ':sid': sid },
        },
      });
    } catch (e) {
      if (isConditionFailed(e)) throw new LockBusyError('the active environment lock is held by another session', await this.lock());
      throw e;
    }
  }

  /** Reuse of the KEPT environment `envId` held by `keptSid`: reserve for `sid` until `pendingUntil`. */
  async reserve(sid: string, keptSid: string, envId: string, pendingUntil: string, nowIso: string): Promise<LockItem> {
    try {
      return await this.table.update<LockItem>(Keys.activeEnvironmentLock(), {
        set: { pendingSessionId: sid, pendingUntil, updatedAt: nowIso },
        add: { ver: 1 },
        condition: {
          expression:
            'holderEnvId = :env AND holderSessionId = :kept AND (attribute_not_exists(pendingSessionId) OR pendingUntil < :now OR pendingSessionId = :sid)',
          values: { ':env': envId, ':kept': keptSid, ':now': nowIso, ':sid': sid },
        },
      });
    } catch (e) {
      if (isConditionFailed(e)) throw new LockBusyError('the kept environment is not available for reuse', await this.lock());
      throw e;
    }
  }

  /** Drop a reservation (preflight failed, cancelled, timed out); the KEPT holder keeps the lock. */
  async clearReservation(sid: string, nowIso: string): Promise<void> {
    try {
      await this.table.update(Keys.activeEnvironmentLock(), {
        set: { updatedAt: nowIso },
        remove: ['pendingSessionId', 'pendingUntil'],
        condition: { expression: 'pendingSessionId = :sid', values: { ':sid': sid } },
      });
    } catch (e) {
      if (!isConditionFailed(e)) throw e;
    }
  }

  /** Transaction member for `EnterProvisioning` on reuse: reservation of `sid` still valid → `sid` becomes the holder. */
  transferTx(sid: string, keptSid: string, envId: string, nowIso: string): TransactItem {
    return txUpdate(this.table.name, Keys.activeEnvironmentLock(), {
      set: { holderSessionId: sid, holderEnvId: envId, acquiredAt: nowIso, updatedAt: nowIso },
      remove: ['pendingSessionId', 'pendingUntil'],
      add: { ver: 1 },
      condition: {
        expression: 'pendingSessionId = :sid AND pendingUntil >= :now AND holderSessionId = :kept AND holderEnvId = :env',
        values: { ':sid': sid, ':now': nowIso, ':kept': keptSid, ':env': envId },
      },
    });
  }

  /** `Conclude`: release by the holder (idempotent: a lock already released or held by another session is left alone). */
  async release(sid: string, nowIso: string): Promise<boolean> {
    try {
      await this.table.update(Keys.activeEnvironmentLock(), {
        set: { updatedAt: nowIso },
        remove: ['holderSessionId', 'holderEnvId', 'acquiredAt', 'pendingSessionId', 'pendingUntil'],
        add: { ver: 1 },
        condition: { expression: 'holderSessionId = :sid', values: { ':sid': sid } },
      });
      return true;
    } catch (e) {
      if (isConditionFailed(e)) return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // CatalogRelease

  async currentRelease(): Promise<CatalogReleaseItem | null> {
    const ptr = await this.table.get<Item>(Keys.catalogCurrent());
    if (!ptr) return null;
    const version = (ptr.catalogVersion as string | undefined) ?? null;
    if (!version) return null;
    const rel = await this.table.get<CatalogReleaseItem>(Keys.catalogRelease(version));
    return rel ?? ({ ...ptr, catalogVersion: version } as CatalogReleaseItem);
  }

  async getRelease(catalogVersion: string): Promise<CatalogReleaseItem | null> {
    return this.table.get<CatalogReleaseItem>(Keys.catalogRelease(catalogVersion));
  }

  /** `POST /catalog/releases/{catalogVersion}/defective` (04 §10.7): atl-api writes `defective`. */
  async markDefective(catalogVersion: string, by: string, reason: string | undefined, nowIso: string): Promise<CatalogReleaseItem> {
    return this.table.update<CatalogReleaseItem>(Keys.catalogRelease(catalogVersion), {
      set: { defective: { at: nowIso, by, ...(reason ? { reason } : {}) }, updatedAt: nowIso },
      condition: { expression: 'attribute_exists(PK)' },
    });
  }
}
