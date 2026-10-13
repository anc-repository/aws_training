// 核心业务表：system_meta、users、auth_tokens、albums、photos、photo_labels、moderation_results、upload_sessions
// 约定见 db/dialect.ts：时间为 ISO 8601 UTC 字符串；JSON 列用 jsonb（SQLite 下为文本）；只存逻辑键。
import type { Knex } from 'knex';

const ts = (t: Knex.CreateTableBuilder, name: string, nullable = false) => {
  const c = t.string(name, 32);
  return nullable ? c.nullable() : c.notNullable();
};

export async function up(knex: Knex): Promise<void> {
  // 本地主密钥指纹（CFG-007）等系统元数据
  await knex.schema.createTable('system_meta', (t) => {
    t.string('key', 128).primary();
    t.text('value').notNullable();
    ts(t, 'updated_at');
  });

  // users.id 是内部 UUID，与身份提供方解耦（3.2 决定 4）；local 模式下 auth_subject = id
  await knex.schema.createTable('users', (t) => {
    t.string('id', 36).primary();
    t.string('email', 320).notNullable().unique();
    t.string('display_name', 120).notNullable().defaultTo('');
    t.text('password_hash').nullable();                       // argon2id；auth=cognito 迁移后为 null
    t.boolean('email_verified').notNullable().defaultTo(false);
    t.string('role', 16).notNullable().defaultTo('member');   // admin | member（F12 应用层 RBAC）
    t.string('plan', 32).notNullable().defaultTo('free');     // F4
    t.string('auth_provider', 16).notNullable().defaultTo('local');   // local | cognito
    t.string('auth_subject', 128).notNullable();               // 本地 id 或 Cognito sub
    t.string('identity_id', 128).nullable();                   // identity-pool
    t.text('mfa_secret_enc').nullable();                       // CryptoPort 信封加密（ca1.*）
    t.boolean('mfa_enabled').notNullable().defaultTo(false);
    t.integer('failed_logins').notNullable().defaultTo(0);
    ts(t, 'locked_until', true);
    t.integer('token_version').notNullable().defaultTo(0);     // 登出后旧 access token 立即失效（tv 声明）
    t.string('email_status', 16).notNullable().defaultTo('ok');   // ok | bounced | complained（email=ses）
    t.boolean('disabled').notNullable().defaultTo(false);
    ts(t, 'created_at');
    ts(t, 'updated_at');
    t.unique(['auth_provider', 'auth_subject']);
  });

  // 验证码 / 重置链接 / 刷新令牌：库里只存哈希；同一族（family）的旧 refresh token 被重放时整族作废
  await knex.schema.createTable('auth_tokens', (t) => {
    t.string('id', 36).primary();
    t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('type', 24).notNullable();                        // verify_email | reset_password | refresh | mfa_challenge
    t.string('token_hash', 128).notNullable().unique();
    t.string('family_id', 36).nullable();
    ts(t, 'expires_at');
    ts(t, 'used_at', true);
    ts(t, 'created_at');
    t.index(['user_id', 'type']);
    t.index(['family_id']);
  });

  await knex.schema.createTable('albums', (t) => {
    t.string('id', 36).primary();
    t.string('owner_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.text('description').nullable();
    t.string('visibility', 16).notNullable().defaultTo('private');   // public | private
    t.string('cover_photo_id', 36).nullable();
    t.boolean('is_default').notNullable().defaultTo(false);           // F2：注册事务内建的默认相册
    ts(t, 'created_at');
    ts(t, 'updated_at');
    t.index(['owner_id', 'created_at']);
  });

  // 原图键 raw/<userId>/<photoId>.<ext>；衍生图键由 photoId 推导（variants/<photoId>/thumb_200.webp 等）
  await knex.schema.createTable('photos', (t) => {
    t.string('id', 36).primary();
    t.string('owner_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('album_id', 36).nullable().references('id').inTable('albums').onDelete('SET NULL');
    t.string('raw_key', 512).notNullable();
    t.string('filename', 255).notNullable().defaultTo('');
    t.string('content_type', 64).notNullable();
    t.bigInteger('size_bytes').nullable();
    t.string('status', 16).notNullable().defaultTo('UPLOADING');   // UPLOADING | PROCESSING | READY | FAILED | BLOCKED
    t.string('visibility', 16).notNullable().defaultTo('private');
    t.string('title', 200).nullable();
    t.text('caption').nullable();
    t.string('thumb_key', 512).nullable();
    t.string('display_key', 512).nullable();
    t.integer('width').nullable();
    t.integer('height').nullable();
    t.string('dominant_color', 16).nullable();
    ts(t, 'taken_at', true);
    t.jsonb('labels').nullable();                 // 冗余一份标签，供列表页快速显示
    t.jsonb('processed_by').nullable();           // { driver, durationMs, host, coldStart }
    t.jsonb('workflow').nullable();               // { driver, executionId, attempts }（workflow 模块）
    ts(t, 'processing_started_at', true);
    t.integer('processing_attempts').notNullable().defaultTo(0);
    ts(t, 'ready_at', true);
    t.text('failure_reason').nullable();
    t.text('location_enc').nullable();            // EXIF GPS，CryptoPort 信封加密（ca1.*）
    ts(t, 'created_at');
    ts(t, 'updated_at');
    t.index(['owner_id', 'created_at']);
    t.index(['album_id', 'created_at']);
    t.index(['status', 'processing_started_at']);
    t.index(['visibility', 'created_at']);
  });

  await knex.schema.createTable('photo_labels', (t) => {
    t.string('photo_id', 36).notNullable().references('id').inTable('photos').onDelete('CASCADE');
    t.string('name', 128).notNullable();
    t.float('confidence').notNullable();
    t.string('source', 16).notNullable();          // basic | rekognition
    ts(t, 'created_at');
    t.primary(['photo_id', 'name', 'source']);
    t.index(['name']);
  });

  await knex.schema.createTable('moderation_results', (t) => {
    t.string('photo_id', 36).primary().references('id').inTable('photos').onDelete('CASCADE');
    t.string('verdict', 16).notNullable();         // pass | review | block
    t.jsonb('labels').nullable();
    t.jsonb('analyzed_by').nullable();
    ts(t, 'created_at');
  });

  // F14 本地前缀上传令牌的会话（DirectUploadPort none）：分片落在 uploads/.incoming/<uploadId>/
  await knex.schema.createTable('upload_sessions', (t) => {
    t.string('upload_id', 64).primary();
    t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('photo_id', 36).nullable();
    t.string('prefix', 512).notNullable();
    t.string('mode', 16).notNullable().defaultTo('token');   // token | sts
    t.integer('parts_received').notNullable().defaultTo(0);
    t.bigInteger('bytes_received').notNullable().defaultTo(0);
    ts(t, 'created_at');
    ts(t, 'expires_at');
    ts(t, 'completed_at', true);
    t.index(['user_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['upload_sessions', 'moderation_results', 'photo_labels', 'photos', 'albums', 'auth_tokens', 'users', 'system_meta']) {
    await knex.schema.dropTableIfExists(table);
  }
}
