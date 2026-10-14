// wave1-sns-ses: module hook of notification (module-hooks/notification.ts) — AdminEmail parameter, confirm-email notes,
// re-enabling keeps the deployed AdminEmail, disable notes. Dry-run only (no AWS call is executed).
import { describe, expect, it } from 'vitest';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import type { Prepared } from '../src/hooks.js';
import type { PlanStep } from '../src/deps.js';
import type { HookArgs } from '../src/module-hooks/index.js';
import { notificationHook } from '../src/module-hooks/notification.js';
import type { ModuleRecord } from '../src/state.js';
import { dryContext } from './helpers.js';

const step: PlanStep = { module: 'notification', value: 'sns', tier: 'aws', settings: {}, reason: 'requested', isTarget: true };
const args = (params: Record<string, string> = {}): HookArgs => ({ params, planOnly: false, isTarget: true });
const prepared = (): Prepared => ({ params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] });

function stackParams(calls: Array<{ op: string; input: Record<string, unknown> }>, stack: string): Record<string, string> {
  const deploy = calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === stack)!;
  return Object.fromEntries((deploy.input.Parameters as Array<{ ParameterKey: string; ParameterValue: string }>).map((p) => [p.ParameterKey, p.ParameterValue]));
}

describe('notification hook', () => {
  it('enable --param AdminEmail (dry-run, --no-migrate): AdminEmail reaches the stack; confirm-email and migrate notes; env from the outputs', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'notification', { withDeps: true, migrate: false, param: ['AdminEmail=you+admin@mail.dev'] })).toBe(0);
    expect(stackParams(aws.calls, 'cloudalbum-lab-notification')).toMatchObject({ AdminEmail: 'you+admin@mail.dev', KmsKeyArn: '' });
    expect(out.text()).toContain('confirm the subscription of you+admin@mail.dev (manual prerequisite confirm-email)');
    expect(out.text()).toContain('migrate-module notification is not wired yet');
    expect(ctx.state.modules.notification?.env).toMatchObject({ MODULE_NOTIFICATION: 'on', NOTIFY_DRIVER: 'sns' });
    expect(Object.keys(ctx.state.modules.notification!.env).sort()).toEqual([
      'MODULE_NOTIFICATION', 'MODULE_NOTIFICATION_VERSION', 'NOTIFY_DLQ_URL', 'NOTIFY_DRIVER', 'NOTIFY_INBOX_QUEUE_URL', 'NOTIFY_TOPIC_ARN',
    ]);
  });

  it('without AdminEmail: allowed, with a note; an invalid or reserved-domain address is refused', () => {
    const { ctx } = dryContext();
    expect((notificationHook.plan!(ctx, step, args()) as { notes: string[] }).notes[0]).toContain('no --param AdminEmail');
    expect(() => notificationHook.plan!(ctx, step, args({ AdminEmail: 'nope' }))).toThrow(/not an e-mail address/);
    expect(() => notificationHook.plan!(ctx, step, args({ AdminEmail: 'atl-admin@example.com' }))).toThrow(/reserved domain/);
    expect(() => notificationHook.plan!(ctx, step, args({ AdminEmail: 'ops@corp.test' }))).toThrow(/reserved domain/);
  });

  it('re-enabling without --param keeps the deployed AdminEmail; a different value is announced (new confirmation)', () => {
    const { ctx } = dryContext();
    ctx.state.modules.notification = { params: { AdminEmail: 'old@mail.dev' } } as unknown as ModuleRecord;
    const keep = prepared();
    notificationHook.prepare!(ctx, step, args(), keep);
    expect(keep.params.AdminEmail).toBe('old@mail.dev');
    const change = prepared();
    notificationHook.prepare!(ctx, step, args({ AdminEmail: 'new@mail.dev' }), change);
    expect(change.params.AdminEmail).toBeUndefined();   // --param wins (stackParams merges user parameters last)
    expect(change.notes[0]).toContain('AdminEmail changes old@mail.dev -> new@mail.dev');
  });

  it('disable --dry-run --no-migrate: notes about the subscriptions; topic stack deleted', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'notification', { withDeps: true, migrate: false })).toBe(0);
    expect(await disableCommand(ctx, 'notification', { migrate: false })).toBe(0);
    expect(out.text()).toContain('notification_prefs.email_enabled stays in the database');
    expect(out.text()).toContain('all subscriptions deleted with the stack');
    expect(aws.calls.some((c) => c.op === 'DeleteStack' && c.input.StackName === 'cloudalbum-lab-notification')).toBe(true);
  });

  it('planHints name the manual prerequisite confirm-email', () => {
    expect(notificationHook.planHints!(step).join(' ')).toContain('manual prerequisite "confirm-email"');
    expect(notificationHook.planHints!({ ...step, tier: 'local', value: 'db' })).toEqual([]);
  });
});
