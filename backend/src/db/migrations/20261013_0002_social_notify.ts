// 社交、通知、邮件、点击流：likes、comments、photo_counters、share_links（SocialStorePort(db)）、notifications、
// notification_prefs、notification_deliveries（NotifierPort）、outbox_emails（EmailPort）、click_events（AnalyticsPort(db)）。
// 社交表不建到 photos 的外键：与 DynamoDB 单表语义一致（purgePhoto 负责清理），也便于 social-store 迁移。
import type { Knex } from 'knex';

const ts = (t: Knex.CreateTableBuilder, name: string, nullable = false) => {
  const c = t.string(name, 32);
  return nullable ? c.nullable() : c.notNullable();
};

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('likes', (t) => {
    t.string('photo_id', 36).notNullable();
    t.string('user_id', 36).notNullable();
    ts(t, 'created_at');
    t.primary(['photo_id', 'user_id']);           // 唯一约束：一人一赞
    t.index(['user_id']);
  });

  await knex.schema.createTable('comments', (t) => {
    t.string('id', 32).primary();                 // ULID（与 DynamoDB 的 SK = C#<ulid> 一致）
    t.string('photo_id', 36).notNullable();
    t.string('user_id', 36).notNullable();
    t.text('text').notNullable();
    ts(t, 'created_at');
    t.index(['photo_id', 'id']);
    t.index(['user_id', 'id']);
  });

  await knex.schema.createTable('photo_counters', (t) => {
    t.string('photo_id', 36).primary();
    t.integer('likes').notNullable().defaultTo(0);
    t.integer('comments').notNullable().defaultTo(0);
    ts(t, 'updated_at');
  });

  await knex.schema.createTable('share_links', (t) => {
    t.string('token', 64).primary();
    t.string('photo_id', 36).notNullable();
    t.string('created_by', 36).notNullable();
    ts(t, 'created_at');
    ts(t, 'expires_at');                          // 读取时校验；share.cleanup 定时清理
    t.index(['photo_id']);
    t.index(['expires_at']);
  });

  // 站内信始终由核心服务写入（NotifierPort 只负责站外渠道）
  await knex.schema.createTable('notifications', (t) => {
    t.string('id', 36).primary();
    t.string('event_id', 64).notNullable().unique();   // NotificationEvent.eventId（幂等）
    t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('type', 32).notNullable();
    t.string('title', 200).notNullable();
    t.text('body').notNullable();
    t.string('link', 512).nullable();
    t.jsonb('data').nullable();
    ts(t, 'read_at', true);
    ts(t, 'created_at');
    t.index(['user_id', 'created_at']);
  });

  await knex.schema.createTable('notification_prefs', (t) => {
    t.string('user_id', 36).primary().references('id').inTable('users').onDelete('CASCADE');
    t.boolean('email_enabled').notNullable().defaultTo(false);
    t.string('sns_subscription_arn', 512).nullable();
    t.string('sns_status', 32).nullable();        // pending | confirmed
    ts(t, 'updated_at');
  });

  await knex.schema.createTable('notification_deliveries', (t) => {
    t.string('id', 36).primary();
    t.string('event_id', 64).notNullable();
    t.string('channel', 16).notNullable();        // email | sns | sqs-copy
    t.string('target', 320).nullable();
    t.string('status', 16).notNullable();
    t.text('detail').nullable();
    ts(t, 'at');
    t.index(['event_id']);
  });

  // EmailPort(outbox)：每封邮件一个 .eml（OUTBOX_DIR/<yyyy-mm-dd>/<messageId>.eml）+ 一行记录；ses 档同样写记录（不存正文）
  await knex.schema.createTable('outbox_emails', (t) => {
    t.string('id', 36).primary();
    t.string('message_id', 128).notNullable().unique();
    t.jsonb('to_addrs').notNullable();
    t.string('subject', 300).notNullable();
    t.string('category', 24).notNullable();       // verification | password-reset | notification | report | system
    t.string('transport', 16).notNullable();      // outbox | ses
    t.string('status', 16).notNullable();         // queued | sent | failed
    t.string('delivery_status', 16).notNullable().defaultTo('none');   // none | delivered | bounced | complained | rejected | delayed
    t.string('provider_message_id', 128).nullable();
    t.text('error').nullable();
    t.string('user_id', 36).nullable();           // 收件人是本站用户时（/me/outbox）
    t.string('eml_path', 512).nullable();
    ts(t, 'created_at');
    ts(t, 'sent_at', true);
    t.index(['user_id', 'created_at']);
    t.index(['created_at']);
  });

  // AnalyticsPort(db)：event_id 唯一，ON CONFLICT DO NOTHING；不存原始 IP
  await knex.schema.createTable('click_events', (t) => {
    t.string('event_id', 64).primary();
    ts(t, 'ts');
    t.string('session_id', 64).notNullable();
    t.string('user_id', 36).nullable();
    t.string('type', 24).notNullable();
    t.string('path', 512).notNullable();
    t.string('photo_id', 36).nullable();
    t.string('referrer', 512).nullable();
    t.string('ua_family', 64).nullable();
    t.string('ip_hash', 64).notNullable();
    t.index(['ts']);
    t.index(['type', 'ts']);
    t.index(['photo_id', 'ts']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['click_events', 'outbox_emails', 'notification_deliveries', 'notification_prefs', 'notifications',
    'share_links', 'photo_counters', 'comments', 'likes']) {
    await knex.schema.dropTableIfExists(table);
  }
}
