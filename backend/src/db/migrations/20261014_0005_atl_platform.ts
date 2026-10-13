// ATL 平台模式（docs/platform/06-cloudalbum-platform-mode.md）：
//   - atl_probe_nonces：一次性探测令牌的 nonce 登记（PM-09；主键冲突 = 重放 → 401 PROBE_TOKEN_REPLAYED；
//     worker 每 10 分钟删除 exp < now - 600 的行，定时任务 atl.probe-nonce-gc）。多实例时在共享库中，令牌在任一实例上都可验证。
//   - lab_runs：登记表增加 variant（{label, role?, cardVariant?}）与 window_sec（PM-37、PM-40 的时间窗归属）。
//   - lab_metric_rollups：status_class（2xx / 3xx / 4xx / 5xx），`cloudalbum lab-metrics` 的 byStatus（PM-14）。
//   - users / photos：seed_id（测试数据种子的幂等依据，PM-43～PM-45）；photos.seed_digest = 种子文件摘要。
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('atl_probe_nonces', (t) => {
    t.string('nonce', 32).primary();
    t.bigInteger('exp').notNullable();            // Unix 秒
    t.bigInteger('used_at').notNullable();        // Unix 秒
    t.string('instance_id', 64).nullable();
    t.index(['exp']);
  });
  await knex.schema.alterTable('lab_runs', (t) => {
    t.jsonb('variant').nullable();
    t.integer('window_sec').nullable();
  });
  await knex.schema.alterTable('lab_metric_rollups', (t) => {
    t.string('status_class', 4).nullable();
  });
  await knex.schema.alterTable('users', (t) => {
    t.string('seed_id', 64).nullable();
  });
  await knex.schema.alterTable('photos', (t) => {
    t.string('seed_id', 64).nullable();
    t.string('seed_digest', 80).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('photos', (t) => {
    t.dropColumn('seed_digest');
    t.dropColumn('seed_id');
  });
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('seed_id');
  });
  await knex.schema.alterTable('lab_metric_rollups', (t) => {
    t.dropColumn('status_class');
  });
  await knex.schema.alterTable('lab_runs', (t) => {
    t.dropColumn('window_sec');
    t.dropColumn('variant');
  });
  await knex.schema.dropTableIfExists('atl_probe_nonces');
}
