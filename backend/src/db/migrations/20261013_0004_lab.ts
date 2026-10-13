// /lab 与本地评估器：capability_events（状态时间线）、lab_runs、lab_results、lab_metric_rollups、lab_host_samples、
// lab_origin_samples（LabMetricsStore，§7.3）、alert_events（monitoring 本地告警评估器）、security_findings
// （threat-detection 本地分析器）、compliance_evaluations（compliance 本地自检器）。SQLite 与 PostgreSQL 均可，ASG 下共享。
import type { Knex } from 'knex';

const ts = (t: Knex.CreateTableBuilder, name: string, nullable = false) => {
  const c = t.string(name, 32);
  return nullable ? c.nullable() : c.notNullable();
};

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('capability_events', (t) => {
    t.bigIncrements('id');
    ts(t, 'ts');
    t.string('module', 32).notNullable();
    t.string('field', 16).notNullable().defaultTo('status');   // status | localHealth
    t.string('from_status', 16).notNullable();
    t.string('to_status', 16).notNullable();
    t.text('detail').nullable();
    t.string('instance_id', 64).nullable();
    t.string('role', 8).nullable();
    t.index(['module', 'ts']);
    t.index(['ts']);
  });

  // 实验运行登记（POST /api/lab/runs）：时间窗与归属
  await knex.schema.createTable('lab_runs', (t) => {
    t.string('run_id', 32).primary();             // ULID
    t.string('module', 32).notNullable();
    t.string('experiment', 64).notNullable();
    t.string('label', 64).notNullable();
    ts(t, 'started_at');
    ts(t, 'finished_at', true);
    t.string('created_by', 36).nullable();
    t.jsonb('params').nullable();
    t.boolean('forced').notNullable().defaultTo(false);
    t.text('notes').nullable();
    t.index(['module', 'started_at']);
  });

  // 运行器 --upload 的结果（result.schema.json）
  await knex.schema.createTable('lab_results', (t) => {
    t.string('run_id', 32).primary();
    t.string('module', 32).notNullable();
    t.string('experiment', 64).notNullable();
    t.string('label', 64).notNullable();
    ts(t, 'started_at');
    ts(t, 'finished_at');
    t.boolean('forced').notNullable().defaultTo(false);
    t.jsonb('result').notNullable();
    ts(t, 'uploaded_at');
    t.index(['module', 'experiment', 'started_at']);
  });

  // LabMetricsStore 的分钟级汇总（每 10 秒 flush 一次，同一分钟可能有多行，查询时合并）；lab.compact 把 2 天前的压缩为小时级
  await knex.schema.createTable('lab_metric_rollups', (t) => {
    t.bigIncrements('id');
    ts(t, 'minute');
    t.string('granularity', 8).notNullable().defaultTo('minute');   // minute | hour
    t.string('instance_id', 64).notNullable();
    t.string('role', 8).notNullable();
    t.string('kind', 8).notNullable();            // route | port
    t.string('route', 256).nullable();
    t.string('method', 8).nullable();
    t.string('path_sig', 512).nullable();
    t.string('module', 32).nullable();
    t.string('driver', 32).nullable();
    t.string('op', 64).nullable();
    t.string('run_id', 32).nullable();
    t.string('label', 64).nullable();
    t.integer('count').notNullable();
    t.integer('errors').notNullable().defaultTo(0);
    t.float('sum_ms').notNullable();
    t.float('max_ms').notNullable();
    t.jsonb('hist').notNullable();                // 对数分桶计数（observability/lab-metrics.ts HIST_EDGES_MS）
    t.index(['minute']);
    t.index(['run_id']);
    t.index(['kind', 'route', 'minute']);
  });

  await knex.schema.createTable('lab_host_samples', (t) => {
    t.bigIncrements('id');
    ts(t, 'ts');
    t.string('instance_id', 64).notNullable();
    t.string('role', 8).notNullable();
    t.integer('pid').nullable();
    t.float('cpu_pct').nullable();
    t.bigInteger('rss_bytes').nullable();
    t.bigInteger('heap_used_bytes').nullable();
    t.float('event_loop_delay_p99_ms').nullable();
    t.float('loadavg1').nullable();
    t.float('steal_pct').nullable();
    t.float('mem_used_ratio').nullable();
    t.bigInteger('net_rx_bytes').nullable();
    t.bigInteger('net_tx_bytes').nullable();
    t.float('data_used_pct').nullable();
    t.index(['ts']);
    t.index(['instance_id', 'ts']);
  });

  // 源站卸载：worker 增量读取 Nginx JSON 访问日志，按 cf_id / alb_trace 是否为空统计
  await knex.schema.createTable('lab_origin_samples', (t) => {
    t.bigIncrements('id');
    ts(t, 'minute');
    t.string('instance_id', 64).notNullable();
    t.integer('requests').notNullable().defaultTo(0);
    t.bigInteger('bytes').notNullable().defaultTo(0);
    t.integer('via_cloudfront').notNullable().defaultTo(0);
    t.integer('via_alb').notNullable().defaultTo(0);
    t.integer('direct').notNullable().defaultTo(0);
    t.index(['minute']);
  });

  await knex.schema.createTable('alert_events', (t) => {
    t.bigIncrements('id');
    ts(t, 'ts');
    t.string('alarm', 128).notNullable();
    t.string('state', 16).notNullable();          // OK | ALARM | INSUFFICIENT_DATA
    t.float('value').nullable();
    t.text('detail').nullable();
    t.string('source', 16).notNullable().defaultTo('local');   // local | cloudwatch
    t.index(['alarm', 'ts']);
  });

  await knex.schema.createTable('security_findings', (t) => {
    t.bigIncrements('id');
    t.string('type', 64).notNullable();
    t.string('severity', 16).notNullable();
    t.string('source', 16).notNullable().defaultTo('local');   // local | guardduty
    t.string('resource', 256).nullable();
    t.string('source_ip', 64).nullable();
    ts(t, 'first_seen');
    ts(t, 'last_seen');
    t.integer('count').notNullable().defaultTo(1);
    t.jsonb('detail').nullable();
    t.index(['last_seen']);
  });

  // 只记录检查项的状态变化（而不是每次评估），供 /lab 画“本机配置漂移”时间线
  await knex.schema.createTable('compliance_evaluations', (t) => {
    t.bigIncrements('id');
    t.string('rule_id', 64).notNullable();
    t.string('resource', 256).notNullable();
    t.string('status', 16).notNullable();         // COMPLIANT | NON_COMPLIANT | NOT_APPLICABLE
    t.string('source', 16).notNullable().defaultTo('local');   // local | config
    ts(t, 'evaluated_at');
    t.text('detail').nullable();
    t.index(['rule_id', 'evaluated_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['compliance_evaluations', 'security_findings', 'alert_events', 'lab_origin_samples', 'lab_host_samples',
    'lab_metric_rollups', 'lab_results', 'lab_runs', 'capability_events']) {
    await knex.schema.dropTableIfExists(table);
  }
}
