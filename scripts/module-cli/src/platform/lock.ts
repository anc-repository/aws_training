/**
 * Environment operation lock (06 PM-28): lock table CLOUDALBUM_LOCK_TABLE (cloudalbum-lab-locks), key lockKey = "env#<envName>".
 *   item     : holderArn, holder (role session name), op, runId (runner: ATL_RUN_ID; workstation: ws-<ULID>), acquiredAt,
 *              leaseUntil (Unix seconds), ver, ttl (= leaseUntil + 86400, cleanup only)
 *   lease    : 300 s; renewed every 60 s (UpdateItem SET leaseUntil, ver = ver + 1 IF holderArn = :me AND ver = :v);
 *              2 consecutive renewal failures -> abort flag: the command stops at the next safe point with exit 7 ENV_LOCK_LOST
 *              and does not write state.json any more
 *   acquire  : PutItem IF attribute_not_exists(lockKey) OR leaseUntil < :now - 30 (30 s clock skew); otherwise read the holder;
 *              --lock-wait <s> > 0 retries every 10 s until the deadline, else exit 7 ENV_LOCK_BUSY with the holder on stdout
 *   release  : DeleteItem IF holderArn = :me AND ver = :v (failures ignored: the lease expires)
 *   takeover : only after the lease expired (no force-unlock command)
 */
import type { AwsGateway } from '../aws.js';
import { isAwsError } from '../aws.js';
import { CliError, EXIT } from '../printer.js';
import { sleep } from '../deliver.js';

export const LEASE_SEC = 300;
export const RENEW_SEC = 60;
export const SKEW_SEC = 30;
export const RETRY_SEC = 10;

export function envLockKey(envName: string): string {
  return `env#${envName}`;
}

export interface LockHolder { holder: string; holderArn?: string; op: string; runId: string; acquiredAt: string; leaseUntil: string }

type Attr = { S?: string; N?: string };
type Item = Record<string, Attr>;

export interface LockOptions {
  table: string;
  envName: string;
  holderArn: string;
  holder: string;
  op: string;
  runId: string;
  /** seconds to wait for a busy lock (workstation 0, runner 900) */
  waitSec: number;
  now?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  /** renewal interval in ms (tests) */
  renewMs?: number;
}

function holderOf(item: Item | undefined): LockHolder | null {
  if (!item) return null;
  const lease = Number(item.leaseUntil?.N ?? 0);
  return {
    holder: item.holder?.S ?? '?', ...(item.holderArn?.S ? { holderArn: item.holderArn.S } : {}), op: item.op?.S ?? '?',
    runId: item.runId?.S ?? '?', acquiredAt: item.acquiredAt?.S ?? '?', leaseUntil: new Date(lease * 1000).toISOString(),
  };
}

export class EnvLock {
  ver = 0;
  lost = false;
  private failures = 0;
  private timer?: NodeJS.Timeout;
  waitedSec = 0;
  constructor(private readonly aws: AwsGateway, private readonly o: LockOptions) {}

  private now(): number {
    return Math.floor((this.o.now?.() ?? Date.now()) / 1000);
  }

  get key(): string {
    return envLockKey(this.o.envName);
  }

  /** acquire (with --lock-wait); throws CliError(7, ENV_LOCK_BUSY) */
  async acquire(): Promise<void> {
    const start = this.now();
    const deadline = start + Math.max(0, this.o.waitSec);
    for (;;) {
      const now = this.now();
      const lease = now + LEASE_SEC;
      try {
        await this.aws.send({
          service: 'dynamodb', op: 'PutItem',
          input: {
            TableName: this.o.table,
            Item: {
              lockKey: { S: this.key }, holderArn: { S: this.o.holderArn }, holder: { S: this.o.holder }, op: { S: this.o.op.slice(0, 200) },
              runId: { S: this.o.runId }, acquiredAt: { S: new Date(now * 1000).toISOString() }, leaseUntil: { N: String(lease) },
              ver: { N: '1' }, ttl: { N: String(lease + 86_400) },
            },
            ConditionExpression: 'attribute_not_exists(lockKey) OR leaseUntil < :stale',
            ExpressionAttributeValues: { ':stale': { N: String(now - SKEW_SEC) } },
          },
        });
        this.ver = 1;
        this.waitedSec = now - start;
        this.startRenewal();
        return;
      } catch (e) {
        if (!isAwsError(e, 'ConditionalCheckFailedException')) throw e;
      }
      const cur = await this.aws.send<{ Item?: Item }>({ service: 'dynamodb', op: 'GetItem',
        input: { TableName: this.o.table, Key: { lockKey: { S: this.key } }, ConsistentRead: true } });
      const holder = holderOf(cur?.Item);
      if (this.now() + RETRY_SEC > deadline) {
        throw new CliError(`environment lock ${this.key} is held by ${holder?.holder ?? 'another operation'} (${holder?.op ?? '?'}, lease until ${holder?.leaseUntil ?? '?'})`,
          EXIT.lock, 'ENV_LOCK_BUSY', { ...(holder ?? {}) });
      }
      await (this.o.sleepMs ?? sleep)(RETRY_SEC * 1000);
    }
  }

  /** one renewal; 2 consecutive failures set `lost` */
  async renew(): Promise<boolean> {
    const lease = this.now() + LEASE_SEC;
    try {
      await this.aws.send({
        service: 'dynamodb', op: 'UpdateItem',
        input: {
          TableName: this.o.table, Key: { lockKey: { S: this.key } },
          UpdateExpression: 'SET leaseUntil = :lease, #ttl = :ttl, ver = ver + :one',
          ConditionExpression: 'holderArn = :me AND ver = :v',
          ExpressionAttributeNames: { '#ttl': 'ttl' },   // TTL is a DynamoDB reserved word
          ExpressionAttributeValues: { ':lease': { N: String(lease) }, ':ttl': { N: String(lease + 86_400) }, ':one': { N: '1' },
            ':me': { S: this.o.holderArn }, ':v': { N: String(this.ver) } },
        },
      });
      this.ver += 1;
      this.failures = 0;
      return true;
    } catch {
      this.failures += 1;
      if (this.failures >= 2) this.lost = true;
      return false;
    }
  }

  private startRenewal(): void {
    if (this.aws.dryRun) return;
    this.timer = setInterval(() => { void this.renew(); }, this.o.renewMs ?? RENEW_SEC * 1000);
    this.timer.unref();
  }

  /** the next safe point: throws ENV_LOCK_LOST once the lease could not be renewed twice */
  assertHeld(): void {
    if (this.lost) throw new CliError(`environment lock ${this.key} lost (lease renewal failed twice): stopping before writing state.json`, EXIT.lock, 'ENV_LOCK_LOST');
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.ver === 0) return;
    await this.aws.send({
      service: 'dynamodb', op: 'DeleteItem',
      input: { TableName: this.o.table, Key: { lockKey: { S: this.key } }, ConditionExpression: 'holderArn = :me AND ver = :v',
        ExpressionAttributeValues: { ':me': { S: this.o.holderArn }, ':v': { N: String(this.ver) } } },
    }).catch(() => undefined);
    this.ver = 0;
  }
}

/** read-only: who holds the lock (status --json) */
export async function readLock(aws: AwsGateway, table: string, envName: string): Promise<LockHolder | null> {
  const cur = await aws.send<{ Item?: Item }>({ service: 'dynamodb', op: 'GetItem',
    input: { TableName: table, Key: { lockKey: { S: envLockKey(envName) } }, ConsistentRead: true } }).catch(() => undefined);
  return holderOf(cur?.Item);
}
