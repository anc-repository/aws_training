/**
 * scripts/module hook of notification (wave1-sns-ses). Contract: ./types.ts.
 * Design: docs/modules/04-compute-async.md#notification (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 *
 * What this module needs beyond the generic flow:
 *   - --param AdminEmail=<address> (template parameter, not a secret): the operator / admin fallback subscription with the filter
 *     policy {"audience":["admin"]}. Optional: without it the stack has no admin subscription (admin broadcasts then only reach admin
 *     users that turned e-mail notifications on). Validated here; a reserved-domain address (example.com, .test, ...) is refused
 *     because nobody could ever confirm it.
 *   - prerequisite confirm-email (manual, never blocks): every e-mail subscription stays PendingConfirmation until the recipient
 *     clicks the AWS confirmation link; the probe reports degraded "运维订阅待确认" until the admin subscription is confirmed.
 *   - migration scripts/migrate/notification: backend/src/adapters/notification/migrate.ts implements plan / up / down / verify and
 *     `migrate-module notification` (backend/src/cli/migrate-module.ts) is wired to it (wave1-integration). Its target is the SNS driver,
 *     so it runs only where NOTIFY_DRIVER=sns: disable step 3 (down, still sns) works; enable step 6 runs before modules.d is written
 *     (still db), so enable needs --no-migrate and `migrate-module notification up` runs on the instance after the switch (or the
 *     user subscriptions are created through the API: experiments/notification/subscribe-users.ts).
 *   - disable: the topic deletion removes every remaining subscription (no out-of-band resources).
 * Platform mode (06 PM-M23): no out-of-band calls; the subscriptions the learner confirms are part of the card (manual prerequisite).
 */
import type { ModuleHook } from './types.js';
import { CliError, EXIT } from '../printer.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RESERVED = /@([a-z0-9.-]+\.)?(example\.(com|net|org))$|\.(example|invalid|test|localhost)$/i;

const MIGRATE_NOTE = 'migrate-module notification is not wired into enable (step 6 runs before the switch to sns): run enable with --no-migrate; '
  + 'existing users with e-mail notifications on then get their subscriptions on the instance with `node dist/cli.js migrate-module notification up` '
  + 'or via `npx tsx experiments/notification/subscribe-users.ts` (PUT /api/notifications/prefs -> SNS Subscribe with the userId filter policy)';

export const notificationHook: ModuleHook = {
  id: 'notification',

  planHints(target) {
    if (target.tier !== 'aws') return [];
    return [
      'manual prerequisite "confirm-email": the admin (--param AdminEmail=<your address>) and every user with e-mail notifications on '
      + 'must click the "AWS Notification - Subscription Confirmation" link; unconfirmed subscriptions receive nothing',
    ];
  },

  plan(_ctx, step, args) {
    if (step.tier !== 'aws' || !args.isTarget) return {};
    const notes: string[] = [];
    const admin = (args.params.AdminEmail ?? '').trim();
    if (!admin) {
      notes.push('no --param AdminEmail: no operator subscription (admin broadcasts reach only admin users with e-mail notifications on)');
    } else if (!EMAIL_RE.test(admin)) {
      throw new CliError(`notification: AdminEmail=${admin} is not an e-mail address`, EXIT.rules, 'BAD_PARAM');
    } else if (RESERVED.test(admin)) {
      throw new CliError(`notification: AdminEmail=${admin} uses a reserved domain (example.com, .test, ...): nobody can confirm the subscription`, EXIT.rules, 'BAD_PARAM');
    } else {
      notes.push(`after the deployment, confirm the subscription of ${admin} (manual prerequisite confirm-email); until then the probe is degraded "运维订阅待确认"`);
    }
    notes.push(MIGRATE_NOTE);
    return { notes };
  },

  prepare(ctx, step, args, p) {
    if (step.tier !== 'aws' || !args.isTarget) return;
    // re-enabling without --param keeps the deployed AdminEmail (a different value replaces the subscription: new confirmation e-mail)
    const prev = ctx.state.modules.notification?.params.AdminEmail;
    if (args.params.AdminEmail === undefined && prev) p.params.AdminEmail = prev;
    else if (prev && args.params.AdminEmail !== undefined && args.params.AdminEmail !== prev) {
      p.notes.push(`notification: AdminEmail changes ${prev} -> ${args.params.AdminEmail || "''"}: the old subscription is deleted, the new one needs a confirmation`);
    }
  },

  afterDeploy(ctx, _step, _args, deployed) {
    const admin = deployed.outputs.InfoAdminSubscription;
    if (admin && admin !== 'none') ctx.out.warn(`      notification: confirm the operator subscription: ${admin}`);
    ctx.out.info(`      notification: topic ${deployed.outputs.InfoTopicArn ?? '<InfoTopicArn>'}; inbox ${deployed.outputs.EnvNotifyInboxQueueUrl ?? '<EnvNotifyInboxQueueUrl>'}`);
  },

  beforeDisable() {
    return {
      notes: [
        'user subscriptions: `migrate-module notification down` (step 3) removes them and clears the subscription ARNs (with --no-migrate the topic deletion removes them and the ARNs stay in notification_prefs)',
        'notification_prefs.email_enabled stays in the database: after the switch back to db the users keep their setting (e-mails via EmailPort again)',
      ],
    };
  },

  afterDisable(ctx) {
    ctx.out.info('      notification: topic, inbox, DLQ and all subscriptions deleted with the stack; confirmation / notification e-mails already received stay in the mailboxes');
  },
};
