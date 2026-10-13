/**
 * StackGuard (01 §4.6, §4.7 #6): created last; turns on termination protection of the platform stack and writes the stack
 * policy that forbids Update:Replace / Update:Delete of the data and identity anchors. Delete does nothing — termination
 * protection is switched off by `POST /platform/uninstall/prepare` once the platform is ready to be removed (01 §4.8).
 * Whether SetStackPolicy is accepted while the stack is still CREATE_IN_PROGRESS is checked by 07 (V5-1 step 2); if it is
 * refused the install continues with termination protection on, and the failure is recorded in `PlatformConfig.stackGuard`
 * (shown on the platform health page) instead of rolling the whole installation back.
 */
import { Keys } from '@atl/shared';
import type { CfnEvent, CfnResult } from '../cfn.js';
import { defaultPhysicalId, optProp, prop } from '../cfn.js';
import type { Ports } from '../ports.js';

export function stackPolicy(protectedResources: string[]): string {
  return JSON.stringify({
    Statement: [
      { Effect: 'Allow', Action: 'Update:*', Principal: '*', Resource: '*' },
      {
        Effect: 'Deny',
        Action: ['Update:Replace', 'Update:Delete'],
        Principal: '*',
        Resource: protectedResources.map((id) => `LogicalResourceId/${id}`),
      },
    ],
  });
}

export async function stackGuard(event: CfnEvent, ports: Ports): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  if (event.RequestType === 'Delete') return { physicalResourceId: id };
  const stackId = prop(event, 'StackId');
  const list = event.ResourceProperties.ProtectedResources;
  if (!Array.isArray(list) || !list.length) throw new Error('StackGuard: ProtectedResources must be a non-empty list');
  await ports.stack.updateTerminationProtection(stackId, true);
  let policy: 'set' | 'failed' = 'set';
  let error: string | null = null;
  try {
    await ports.stack.setStackPolicy(stackId, stackPolicy(list.map(String)));
  } catch (e) {
    policy = 'failed';
    error = e instanceof Error ? e.message : String(e);
    ports.log('SetStackPolicy failed; termination protection is on', { error });
  }
  const table = optProp(event, 'Table');
  if (table) {
    await ports.table.update(table, Keys.platformConfig(), {
      stackGuard: { terminationProtection: true, stackPolicy: policy, error, at: ports.now().toISOString() },
    });
  }
  return { physicalResourceId: id, data: { TerminationProtection: 'enabled', StackPolicy: policy } };
}
