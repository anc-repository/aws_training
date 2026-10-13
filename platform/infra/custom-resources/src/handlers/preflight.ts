/**
 * Preflight (01 §4.1): non-blocking account checks at install time; the result is written to `PlatformConfig.preflight`
 * and shown on the platform health page. Never fails the stack: every check reports `unknown` when it cannot run.
 */
import { Keys } from '@atl/shared';
import type { CfnEvent, CfnResult } from '../cfn.js';
import { defaultPhysicalId, optProp, prop } from '../cfn.js';
import type { Ports, PreflightItem } from '../ports.js';

export async function preflight(event: CfnEvent, ports: Ports): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  if (event.RequestType === 'Delete') return { physicalResourceId: id };
  const table = prop(event, 'Table');
  let items: PreflightItem[];
  try {
    items = await ports.preflight.run({
      region: optProp(event, 'Region') || process.env.AWS_REGION || '',
      externalAccessAnalyzer: optProp(event, 'ExternalAccessAnalyzer') || 'create',
      workstationInstanceType: optProp(event, 'WorkstationInstanceType'),
    });
  } catch (e) {
    items = [{ id: 'preflight', status: 'unknown', detail: `preflight could not run: ${e instanceof Error ? e.message : String(e)}` }];
  }
  await ports.table.update(table, Keys.platformConfig(), { preflight: { checkedAt: ports.now().toISOString(), items } });
  const warnings = items.filter((i) => i.status === 'warn').length;
  return { physicalResourceId: id, data: { Warnings: String(warnings) } };
}
