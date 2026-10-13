// 任务与审计：job_runs（SchedulerPort 两种驱动 + PhotoPipeline 每一步）、processed_jobs（队列 handler 幂等）、
// audit_log（应用内审计，append-only + 哈希链；05#audit 的 DDL，PostgreSQL 用 bigserial 与 plpgsql 触发器）。
import type { Knex } from 'knex';
import { dialectOf } from '../dialect.js';
import { migrationParams } from './params.js';

const ts = (t: Knex.CreateTableBuilder, name: string, nullable = false) => {
  const c = t.string(name, 32);
  return nullable ? c.nullable() : c.notNullable();
};

export async function up(knex: Knex): Promise<void> {
  // 幂等键 = (name, scheduled_at)：重复的 tick 插入时撞上唯一索引，记为 skipped-duplicate。
  // PhotoPipeline 的步骤行 name = pipeline.<step>、subject_id = <photoId>、scheduled_at 留空（NULL 互不相同）。
  await knex.schema.createTable('job_runs', (t) => {
    t.string('run_id', 36).primary();
    t.string('name', 64).notNullable();
    t.string('subject_id', 64).nullable();
    ts(t, 'scheduled_at', true);
    ts(t, 'started_at');
    ts(t, 'finished_at', true);
    t.string('status', 24).notNullable();         // running | ok | failed | skipped-locked | skipped-duplicate
    t.string('host', 128).notNullable();
    t.string('trigger', 16).notNullable();        // cron | eventbridge | manual | pipeline
    t.integer('attempt').notNullable().defaultTo(1);
    t.string('executor', 32).nullable();          // inline | worker | lambda | stepfunctions
    t.text('error').nullable();
    t.jsonb('detail').nullable();
    t.unique(['name', 'scheduled_at']);
    t.index(['subject_id']);
    t.index(['started_at']);
  });

  // 队列 handler 的幂等记录（04#queue：先查 job.id 或 dedupKey，已处理则直接返回）
  await knex.schema.createTable('processed_jobs', (t) => {
    t.string('job_key', 128).primary();
    t.string('name', 64).notNullable();
    ts(t, 'processed_at');
    t.index(['processed_at']);
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.bigIncrements('id');
    ts(t, 'ts');                                  // ISO 8601 UTC
    t.string('actor_type', 16).notNullable();     // user | admin | system | anonymous
    t.string('actor_id', 64).nullable();
    t.string('actor_email', 320).nullable();
    t.string('action', 64).notNullable();         // photo.delete、user.login_failed、module.enable、lab.bypass …
    t.string('target_type', 32).nullable();
    t.string('target_id', 128).nullable();
    t.string('result', 16).notNullable();         // success | denied | error
    t.string('source_ip', 64).nullable();
    t.string('user_agent', 512).nullable();
    t.string('request_id', 64).nullable();
    t.string('trace_id', 64).nullable();
    t.string('aws_principal', 256).nullable();    // 应用这次调用 AWS 时使用的身份，用来和 CloudTrail 对照
    t.text('details').nullable();                 // JSON；不得含密码、令牌、完整预签名 URL
    t.string('prev_hash', 64).nullable();
    t.string('hash', 64).notNullable();
    t.index(['ts'], 'audit_log_ts');
    t.index(['actor_id', 'ts'], 'audit_log_actor');
  });

  const days = Math.max(1, Math.floor(migrationParams().auditRetentionDays));
  if (dialectOf(knex) === 'postgres') {
    await knex.raw(`
      CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'audit_log is append-only';
        END IF;
        IF TG_OP = 'DELETE' AND OLD.ts > to_char((now() AT TIME ZONE 'utc') - interval '${days} days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') THEN
          RAISE EXCEPTION 'audit_log row within retention';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;`);
    await knex.raw('CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_guard();');
    await knex.raw('CREATE TRIGGER audit_log_no_early_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_guard();');
  } else {
    await knex.raw(`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`);
    await knex.raw(`CREATE TRIGGER audit_log_no_early_delete BEFORE DELETE ON audit_log
      WHEN OLD.ts > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${days} days')
      BEGIN SELECT RAISE(ABORT, 'audit_log row within retention'); END;`);
  }
}

export async function down(knex: Knex): Promise<void> {
  if (dialectOf(knex) === 'postgres') {
    await knex.raw('DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log');
    await knex.raw('DROP TRIGGER IF EXISTS audit_log_no_early_delete ON audit_log');
    await knex.raw('DROP FUNCTION IF EXISTS audit_log_guard()');
  }
  for (const table of ['audit_log', 'processed_jobs', 'job_runs']) {
    await knex.schema.dropTableIfExists(table);
  }
}
