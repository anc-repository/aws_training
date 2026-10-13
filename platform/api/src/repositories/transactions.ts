/** Transaction member type and builders shared by the repositories (TransactWriteItems, 01 §7.5). */
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { PrimaryKey } from '../data/keys.js';
import { buildUpdate, type Expr, type Item, type UpdateSpec } from './table.js';

export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export function txPut(table: string, item: Item, condition?: Expr): TransactItem {
  return {
    Put: {
      TableName: table,
      Item: item,
      ...(condition
        ? {
            ConditionExpression: condition.expression,
            ...(condition.names ? { ExpressionAttributeNames: condition.names } : {}),
            ...(condition.values ? { ExpressionAttributeValues: condition.values } : {}),
          }
        : {}),
    },
  };
}

export function txUpdate(table: string, key: PrimaryKey, spec: UpdateSpec): TransactItem {
  const u = buildUpdate(spec);
  return {
    Update: {
      TableName: table,
      Key: key,
      ...u,
      ...(spec.condition ? { ConditionExpression: spec.condition.expression } : {}),
    },
  };
}

export function txCheck(table: string, key: PrimaryKey, condition: Expr): TransactItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: key,
      ConditionExpression: condition.expression,
      ...(condition.names ? { ExpressionAttributeNames: condition.names } : {}),
      ...(condition.values ? { ExpressionAttributeValues: condition.values } : {}),
    },
  };
}

export function txDelete(table: string, key: PrimaryKey, condition?: Expr): TransactItem {
  return {
    Delete: {
      TableName: table,
      Key: key,
      ...(condition
        ? {
            ConditionExpression: condition.expression,
            ...(condition.names ? { ExpressionAttributeNames: condition.names } : {}),
            ...(condition.values ? { ExpressionAttributeValues: condition.values } : {}),
          }
        : {}),
    },
  };
}
