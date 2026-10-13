/**
 * `Environment` (01 §7.2, 02 §13.4): created at T02 for a fresh environment, extended at T15 (hand-over), described
 * by the lifecycle (status is descriptive, the authority is the session state).
 */
import { Gsi1, Gsi2, Keys } from '@atl/shared';
import type { Ctx } from '../context.js';
import { err } from '../errors.js';
import { diffItems, Expr, isConditionFailed, updateExpression, type TransactItem } from './ddb.js';
import type { EnvironmentRecord } from './model.js';

export async function getEnvironment(ctx: Ctx, envId: string): Promise<EnvironmentRecord | null> {
  return ctx.main.get<EnvironmentRecord>(Keys.environment(envId));
}

export async function mustGetEnvironment(ctx: Ctx, envId: string): Promise<EnvironmentRecord> {
  const env = await getEnvironment(ctx, envId);
  if (!env) throw err.notFound(`environment ${envId} does not exist`);
  return env;
}

export function withEnvironmentIndexes(env: EnvironmentRecord): EnvironmentRecord {
  const next = { ...env, ...Gsi1.environment(env.createdAt, env.envId) } as EnvironmentRecord & { GSI2PK?: string; GSI2SK?: string };
  const g = Gsi2.environment(env.status, env.envId, env.createdAt, env.keepUntil ?? null);
  if (g) {
    next.GSI2PK = g.GSI2PK;
    next.GSI2SK = g.GSI2SK;
  } else {
    delete next.GSI2PK;
    delete next.GSI2SK;
  }
  return next;
}

/** Put a new environment (condition: does not exist), as a transaction item. */
export function environmentCreate(ctx: Ctx, env: EnvironmentRecord): TransactItem {
  const e = new Expr();
  return {
    Put: {
      TableName: ctx.main.name,
      Item: withEnvironmentIndexes({ ...env, ...Keys.environment(env.envId) }),
      ConditionExpression: `attribute_not_exists(${e.name('PK')})`,
      ...e.input(),
    },
  };
}

/** Versioned update of an environment, as a transaction item. */
export function environmentUpdate(ctx: Ctx, prev: EnvironmentRecord, patch: Partial<EnvironmentRecord>): TransactItem {
  const next = withEnvironmentIndexes({ ...prev, ...patch, ver: prev.ver + 1, updatedAt: ctx.nowIso() });
  const { set, remove } = diffItems(prev, next);
  const e = new Expr();
  const cond = `${e.name('ver')} = ${e.value(prev.ver)}`;
  return { Update: { TableName: ctx.main.name, Key: Keys.environment(prev.envId), UpdateExpression: updateExpression(e, set, remove), ConditionExpression: cond, ...e.input() } };
}

/** Read-modify-write of an environment outside a session transaction. */
export async function mutateEnvironment(
  ctx: Ctx,
  envId: string,
  fn: (env: EnvironmentRecord) => Partial<EnvironmentRecord> | null,
): Promise<EnvironmentRecord | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const prev = await getEnvironment(ctx, envId);
    if (!prev) return null;
    const patch = fn(prev);
    if (!patch) return prev;
    try {
      await ctx.main.transact([environmentUpdate(ctx, prev, patch)]);
      return { ...prev, ...patch };
    } catch (e) {
      if (isConditionFailed(e) || (e as { name?: string }).name === 'TransactionCanceledException') continue;
      throw e;
    }
  }
  throw err.retryable(`environment ${envId}: too many concurrent updates`);
}
