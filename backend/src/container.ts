// backend/src/container.ts —— 装配（总纲 §4.5）
//
// zod 校验 → 规则引擎 → 凭证 → 懒加载驱动 → instrument 包装 → 能力注册。
// - 驱动工厂表全部动态 import：L0 只会命中本地驱动，AWS SDK 永远不被加载。驱动文件一律 adapters/<module>/<driver>.ts，
//   工厂键 `<module>:<driver>`，驱动 id = 开关取值。
// - 不设 DependencyError，也没有 requireAwsCredentials() 或 last-known-good 回退装配：依赖与凭证在第 3 步一次校验完毕（D3）。
// - 配置错误时抛出 ConfigValidationError（附完整报告），入口（server / worker / cli）以退出码 78 退出。
import { hostname } from 'node:os';
import type { Knex } from 'knex';
import { lazyAwsClients, type AwsClients } from './adapters/aws/clients.js';
import { pickLock } from './adapters/lock/index.js';
import type { AdapterDeps } from './adapters/types.js';
import { checkKeyFingerprint } from './config/key-fingerprint.js';
import type { EnvLayers } from './config/load-env.js';
import { storageLocalRoot, type AppConfig } from './config/schema.js';
import { validateConfig } from './config/validate.js';
import { createKnex, databasePathValue, instrumentKnex, migrateLatest } from './db/knex.js';
import { ConfigValidationError, isNotImplemented } from './errors.js';
import { CapabilityRegistry } from './modules/capabilities.js';
import { databaseProbe } from './modules/database-probe.js';
import { DETECTORS } from './modules/detectors/index.js';
import type { Detector } from './modules/detectors/types.js';
import { startLoop, type LoopHandle } from './modules/probe-loop.js';
import { driverOf } from './modules/registry.js';
import { consoleLogger, safeLogger } from './observability/fallback-logger.js';
import { faults, type FaultRegistry } from './observability/faults.js';
import { instrument, type CallObserver } from './observability/instrument.js';
import { LabMetricsStore, type ProcessRole } from './observability/lab-metrics.js';
import { setInstanceIdentity } from './observability/path-header.js';
import type * as P from './ports/index.js';
import type { ModuleId } from './ports/common.js';
import { DEFAULT_RUNTIME_CONFIG } from './ports/config.js';
import { insertCapabilityEvent, labMetricsDbSink } from './repositories/lab.js';
import { printConfigReport, runRules, type Verdict, type RuntimeObservations } from './rules/engine.js';
import { RULES } from './rules/rules.js';

export interface Container {
  role: ProcessRole;
  config: AppConfig;
  /** 有效 env（不含机密以外的进程环境；规则引擎与 capabilities 使用） */
  env: Readonly<Record<string, string>>;
  layers: EnvLayers;
  verdict: Verdict;
  db: Knex;
  dbRead: Knex;
  lock: P.LockPort;
  capabilities: CapabilityRegistry;
  labMetrics: LabMetricsStore;
  faults: FaultRegistry;
  aws: AwsClients;
  awsCreds: P.AwsCredentialsPort;
  storage: P.StoragePort;
  auth: P.AuthPort;
  cache: P.CachePort;
  queue: P.QueuePort;
  images: P.ImageProcessorPort;
  /** inline 适配器始终装配（X-Compare-Bypass: image 与对账重试用，04#image-processing） */
  inlineImages: P.ImageProcessorPort;
  workflow: P.WorkflowPort;
  notifier: P.NotifierPort;
  email: P.EmailPort;
  scheduler: P.SchedulerPort;
  social: P.SocialStorePort;
  tagger: P.TaggerPort;
  secrets: P.SecretsPort;
  runtime: P.ConfigPort;
  /** 运行时配置的安全读取（ConfigPort 未实现或读取失败时返回默认值） */
  runtimeConfig(): P.RuntimeConfig;
  crypto: P.CryptoPort;
  /** 容器与框架使用的 Logger（LoggerPort 不可用时退回 stderr） */
  logger: P.Logger;
  loggerPort: P.LoggerPort;
  metrics: P.MetricsPort;
  tracer: P.TracerPort;
  analytics: P.AnalyticsPort;
  directUpload: P.DirectUploadPort;
  cdn: P.CdnPort;
  blocklist: P.BlocklistPort;
  lifecycle: P.InstanceLifecyclePort;
  detectors: Detector[];
  /** 启动后台循环：探针（30s ± 5s）、运行期规则（60s）、LabMetricsStore flush 与主机采样（10s） */
  startBackground(): void;
  close(): Promise<void>;
}

type Factory = (d: AdapterDeps) => Promise<P.Adapter>;

/** 驱动工厂表：全部动态 import。命名规则 `<module>:<driver>`，文件 adapters/<module>/<driver>.ts。 */
export const FACTORIES: Readonly<Record<string, Factory>> = {
  'iam:none':                   async (d) => new (await import('./adapters/iam/none.js')).NoCredentials(d),
  'iam:role':                   async (d) => new (await import('./adapters/iam/role.js')).RoleCredentials(d),
  'iam:keys':                   async (d) => new (await import('./adapters/iam/keys.js')).KeysCredentials(d),   // 读分层 env（secrets.env）的 IAM_KEYS_*
  'secrets:env':                async (d) => new (await import('./adapters/secrets/env.js')).EnvSecrets(d),     // 分层加载结果，不是 process.env
  'secrets:secretsmanager':     async (d) => new (await import('./adapters/secrets/secretsmanager.js')).SmSecrets(d),
  'logging:file':               async (d) => new (await import('./adapters/logging/file.js')).FileLogger(d),
  'logging:cloudwatch':         async (d) => new (await import('./adapters/logging/cloudwatch.js')).CwLogger(d),
  'storage:local':              async (d) => new (await import('./adapters/storage/local.js')).LocalStorage(d, {
                                  root: storageLocalRoot(d.cfg), module: 'storage', driver: 'local',
                                  awsService: null, redirectPrefix: '/_media_local' }),
  'shared-fs:efs':              async (d) => new (await import('./adapters/storage/local.js')).LocalStorage(d, {
                                  root: storageLocalRoot(d.cfg), module: 'shared-fs', driver: 'efs',
                                  awsService: 'Amazon EFS', redirectPrefix: '/_media_efs', requireMountType: 'nfs4' }),   // 同一个类，只换根目录与元数据
  'storage:s3':                 async (d) => new (await import('./adapters/storage/s3.js')).S3Storage(d),
  'cache:none':                 async (d) => new (await import('./adapters/cache/none.js')).NoCache(d),
  'cache:memory':               async (d) => new (await import('./adapters/cache/memory.js')).MemoryCache(d),
  'cache:redis':                async (d) => new (await import('./adapters/cache/redis.js')).RedisCache(d),
  'queue:sync':                 async (d) => new (await import('./adapters/queue/sync.js')).SyncQueue(d),
  'queue:memory':               async (d) => new (await import('./adapters/queue/memory.js')).MemoryQueue(d),
  'queue:sqs':                  async (d) => new (await import('./adapters/queue/sqs.js')).SqsQueue(d),
  'auth:local':                 async (d) => new (await import('./adapters/auth/local.js')).LocalAuth(d),
  'auth:cognito':               async (d) => new (await import('./adapters/auth/cognito.js')).CognitoAuth(d),
  'image-processing:inline':    async (d) => new (await import('./adapters/image-processing/inline.js')).InlineImageProcessor(d),
  'image-processing:worker':    async (d) => new (await import('./adapters/image-processing/worker.js')).WorkerImageProcessor(d),
  'image-processing:lambda':    async (d) => new (await import('./adapters/image-processing/lambda.js')).LambdaImageProcessor(d),
  'workflow:inline':            async (d) => new (await import('./adapters/workflow/inline.js')).InlineWorkflow(d),
  'workflow:stepfunctions':     async (d) => new (await import('./adapters/workflow/stepfunctions.js')).StepFunctionsWorkflow(d),
  'notification:db':            async (d) => new (await import('./adapters/notification/db.js')).DbNotifier(d),
  'notification:sns':           async (d) => new (await import('./adapters/notification/sns.js')).SnsNotifier(d),
  'email:outbox':               async (d) => new (await import('./adapters/email/outbox.js')).OutboxEmail(d),
  'email:ses':                  async (d) => new (await import('./adapters/email/ses.js')).SesEmail(d),
  'scheduler:cron':             async (d) => new (await import('./adapters/scheduler/cron.js')).CronScheduler(d),
  'scheduler:eventbridge':      async (d) => new (await import('./adapters/scheduler/eventbridge.js')).EventBridgeScheduler(d),
  'social-store:db':            async (d) => new (await import('./adapters/social-store/db.js')).DbSocialStore(d),
  'social-store:dynamodb':      async (d) => new (await import('./adapters/social-store/dynamodb.js')).DynamoSocialStore(d),
  'tagging:none':               async (d) => new (await import('./adapters/tagging/none.js')).NoTagger(d),
  'tagging:rekognition':        async (d) => new (await import('./adapters/tagging/rekognition.js')).RekognitionTagger(d),
  'config:file':                async (d) => new (await import('./adapters/config/file.js')).FileConfig(d),
  'config:ssm':                 async (d) => new (await import('./adapters/config/ssm.js')).SsmConfig(d),
  'kms:local':                  async (d) => new (await import('./adapters/kms/local.js')).LocalCrypto(d),
  'kms:kms':                    async (d) => new (await import('./adapters/kms/kms.js')).KmsCrypto(d),
  'monitoring:local':           async (d) => new (await import('./adapters/monitoring/local.js')).LocalMetrics(d),
  'monitoring:cloudwatch':      async (d) => new (await import('./adapters/monitoring/cloudwatch.js')).CwMetrics(d),
  'tracing:none':               async (d) => new (await import('./adapters/tracing/none.js')).NoTracer(d),
  'tracing:local':              async (d) => new (await import('./adapters/tracing/local.js')).LocalTracer(d),
  'tracing:xray':               async (d) => new (await import('./adapters/tracing/xray.js')).XrayTracer(d),
  'analytics:db':               async (d) => new (await import('./adapters/analytics/db.js')).DbAnalytics(d),
  'analytics:firehose':         async (d) => new (await import('./adapters/analytics/firehose.js')).FirehoseAnalytics(d),
  'identity-pool:none':         async (d) => new (await import('./adapters/identity-pool/none.js')).PrefixTokenUpload(d),
  'identity-pool:cognito':      async (d) => new (await import('./adapters/identity-pool/cognito.js')).CognitoDirectUpload(d),
  'cdn:direct':                 async (d) => new (await import('./adapters/cdn/direct.js')).DirectCdn(d),
  'cdn:cloudfront':             async (d) => new (await import('./adapters/cdn/cloudfront.js')).CloudFrontCdn(d),
  'waf:nginx':                  async (d) => new (await import('./adapters/waf/nginx.js')).NginxBlocklist(d),
  'waf:aws':                    async (d) => new (await import('./adapters/waf/aws.js')).AwsBlocklist(d),
  'autoscaling:single':         async (d) => new (await import('./adapters/autoscaling/single.js')).SingleInstance(d),
  'autoscaling:asg':            async (d) => new (await import('./adapters/autoscaling/asg.js')).AsgInstance(d),
};

interface MakeOptions { instrument?: boolean; register?: boolean }

export interface BuildContainerOptions {
  /** 默认 process.env.CLOUDALBUM_ENV_DIR ?? /etc/cloudalbum */
  envDir?: string;
  processEnv?: NodeJS.ProcessEnv;
  /** 启动探针（默认 true）。CLI 的 probe 命令自己调用。 */
  probeOnStart?: boolean;
  /** 自动执行数据库迁移（默认：NODE_ENV≠production 时执行；EC2 上由引导脚本执行 cli db:migrate） */
  autoMigrate?: boolean;
  /** 测试用：覆盖 SQLite 文件 */
  sqliteFilename?: string;
}

export async function buildContainer(role: ProcessRole, opts: BuildContainerOptions = {}): Promise<Container> {
  // 1)～3) 分层加载 + 键归属检查、结构校验（zod，含未实现的驱动）、语义校验（规则引擎）
  const validation = await validateConfig({
    role,
    ...(opts.envDir ? { envDir: opts.envDir } : {}),
    ...(opts.processEnv ? { processEnv: opts.processEnv } : {}),
  });
  const { layers, parsed, verdict } = validation;
  if (!validation.ok || !parsed.config) {
    const report = printConfigReport(parsed.errors, verdict, () => undefined);
    throw new ConfigValidationError(report);
  }
  const cfg = parsed.config;
  const env = parsed.effective;
  const quiet = cfg.core.NODE_ENV === 'test';
  const bootLog = consoleLogger({ role }, quiet ? 'error' : 'info');

  const caps = new CapabilityRegistry({ cfg, env, verdict, role });
  let instanceId = hostname();
  const labMetrics = new LabMetricsStore({ role, dataDir: cfg.core.CLOUDALBUM_DATA_DIR, instanceId: () => instanceId });
  const observers: CallObserver[] = [caps, labMetrics];

  async function make<T extends P.Adapter>(module: ModuleId, driver: string, d: AdapterDeps, mo: MakeOptions = {}): Promise<T> {
    const factory = FACTORIES[`${module}:${driver}`];
    if (!factory) throw new Error(`未注册的驱动 ${module}:${driver}`);          // 不可能发生：zod 已校验取值
    const adapter = (await factory(d)) as T;
    try {
      await adapter.init?.();
    } catch (e) {
      caps.reportFailure(module, e);                                          // 初始化失败 ≠ 拒绝启动
    }
    if (mo.register !== false) caps.registerAdapter(module, adapter);
    return mo.instrument === false ? adapter : instrument(adapter, { observers, faults });
  }

  // 4) 凭证先行：iam 的驱动决定 SDK 客户端用哪种凭证；none 时 lazyAwsClients 拒绝创建任何客户端
  const base: AdapterDeps = { cfg, env: layers.merged, aws: lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: null }), role, labMetrics };
  const awsCreds = await make<P.AwsCredentialsPort>('iam', cfg.core.IAM_CREDENTIALS, base, { instrument: false });
  let provider: ReturnType<P.AwsCredentialsPort['provider']> = null;
  try {
    provider = awsCreds.provider();
  } catch (e) {
    if (!isNotImplemented(e)) throw e;
    bootLog.warn('AwsCredentialsPort.provider() 尚未实现，AWS 客户端不可用', { driver: cfg.core.IAM_CREDENTIALS });
  }
  const aws = lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: provider });   // 第一次用到某个客户端时才 import SDK 包
  const d: AdapterDeps = { ...base, aws };

  // 5) 有先后依赖的部分：密钥 → 日志 → 数据库（含 dbRead、密钥指纹）→ 缓存 → 锁
  d.secrets = await make<P.SecretsPort>('secrets', driverOf(env, 'secrets'), d);
  const loggerPort = await make<P.LoggerPort>('logging', driverOf(env, 'logging'), d, { instrument: false });
  const logger = safeLogger(loggerPort, { role }, quiet ? 'error' : 'info');
  d.logger = logger;

  const db = instrumentKnex(
    await createKnex(cfg, d.secrets, opts.sqliteFilename ? { sqliteFilename: opts.sqliteFilename } : {}),
    databasePathValue(cfg.db), observers);
  const dbRead = cfg.db.DB_DRIVER === 'postgres' && cfg.db.DB_READ_HOST
    ? instrumentKnex(await createKnex(cfg, d.secrets, { read: true }), databasePathValue(cfg.db, { read: true }), observers)
    : db;
  d.db = db;
  d.dbRead = dbRead;
  if (opts.autoMigrate ?? cfg.core.NODE_ENV !== 'production') {
    await migrateLatest(db, { auditRetentionDays: cfg.core.AUDIT_RETENTION_DAYS });
  } else if (!(await db.schema.hasTable('system_meta'))) {
    throw new Error('数据库尚未迁移：先执行 node dist/cli.js db:migrate');
  }
  await checkKeyFingerprint(db, d.secrets, logger);                   // CFG-007：不一致 → ConfigValidationError（退出 78）
  caps.registerProbe('database', (o) => databaseProbe(db, cfg, { ...(o.deep ? { deep: true } : {}), dbRead }));

  const cache = await make<P.CachePort>('cache', driverOf(env, 'cache'), d);
  d.cache = cache;
  const lock = pickLock(d);                                           // postgres > redis > 文件锁
  d.lock = lock;
  caps.setLockScope(lock.scope);

  // 6) 其余端口：彼此无构造期依赖，并行创建
  const storageModule: ModuleId = cfg.storage.STORAGE_DRIVER === 'efs' ? 'shared-fs' : 'storage';
  const [storage, auth, queue, notifier, email, social, tagger, runtime, crypto, metrics, tracer, analytics,
    cdn, blocklist, lifecycle] = await Promise.all([
    make<P.StoragePort>(storageModule, cfg.storage.STORAGE_DRIVER, d),
    make<P.AuthPort>('auth', driverOf(env, 'auth'), d),
    make<P.QueuePort>('queue', driverOf(env, 'queue'), d),
    make<P.NotifierPort>('notification', driverOf(env, 'notification'), d),
    make<P.EmailPort>('email', driverOf(env, 'email'), d),
    make<P.SocialStorePort>('social-store', driverOf(env, 'social-store'), d),
    make<P.TaggerPort>('tagging', driverOf(env, 'tagging'), d),
    make<P.ConfigPort>('config', driverOf(env, 'config'), d, { instrument: false }),
    make<P.CryptoPort>('kms', driverOf(env, 'kms'), d),
    make<P.MetricsPort>('monitoring', driverOf(env, 'monitoring'), d, { instrument: false }),
    make<P.TracerPort>('tracing', driverOf(env, 'tracing'), d, { instrument: false }),
    make<P.AnalyticsPort>('analytics', driverOf(env, 'analytics'), d),
    make<P.CdnPort>('cdn', driverOf(env, 'cdn'), d),
    make<P.BlocklistPort>('waf', cfg.core.WAF_MODE, d),
    make<P.InstanceLifecyclePort>('autoscaling', cfg.core.DEPLOY_MODE, d, { instrument: false }),
  ]);
  Object.assign(d, { storage, queue, notifier, email, tagger, runtime, crypto, metrics });

  // 依赖其他端口的放在后面：image-processing 依赖 queue（worker 档）与 storage；identity-pool 依赖 storage；
  // workflow 依赖 images 与 tagger（inline 编排）；scheduler 依赖 lock
  const images = await make<P.ImageProcessorPort>('image-processing', cfg.image.IMAGE_PROCESSOR, d);
  const inlineImages = cfg.image.IMAGE_PROCESSOR === 'inline'
    ? images
    : await make<P.ImageProcessorPort>('image-processing', 'inline', d, { register: false });
  d.images = images;
  const directUpload = await make<P.DirectUploadPort>('identity-pool', driverOf(env, 'identity-pool'), d);
  const workflow = await make<P.WorkflowPort>('workflow', cfg.workflow.WORKFLOW_DRIVER, d);
  const scheduler = await make<P.SchedulerPort>('scheduler', driverOf(env, 'scheduler'), d);

  const runtimeConfig = (): P.RuntimeConfig => {
    try {
      return runtime.current();
    } catch {
      return DEFAULT_RUNTIME_CONFIG;
    }
  };
  caps.setRuntimeConfigProvider(runtimeConfig);

  // 7) 感知器（参数型模块的端口已在上面创建）
  const detectors = DETECTORS.map((f) => f.create({ cfg, env, aws }));
  for (const det of detectors) caps.registerDetector(det);

  // 实例身份：X-CloudAlbum-Path 的 inst / az（autoscaling 的 single 驱动从 IMDS 读出；未实现或不在 EC2 上时用主机名）
  try {
    const id = await lifecycle.identity();
    setInstanceIdentity({ instanceId: id.instanceId, az: id.az });
    caps.setInstance({ id: id.instanceId, az: id.az });
    instanceId = id.instanceId;
  } catch (e) {
    if (!isNotImplemented(e)) logger.warn('instance identity unavailable', { error: (e as Error).message });
  }
  try {
    caps.setPublic('auth', { ...auth.publicConfig() });
  } catch {
    caps.setPublic('auth', { driver: driverOf(env, 'auth') });
  }

  labMetrics.setSink(labMetricsDbSink(db));
  caps.onTransition((e) => {
    logger.info('capability.transition', { ...e });
    void insertCapabilityEvent(db, { ...e, role }).catch(() => undefined);
  });

  // 8) 启动探针：并行、每个 2s 超时；结果只影响状态，不阻止启动（配置错误已在第 3 步拦截）
  if (opts.probeOnStart !== false) await caps.probeAll({ timeoutMs: 2000 });

  const loops: LoopHandle[] = [];
  let backgroundStarted = false;
  const c: Container = {
    role, config: cfg, env, layers, verdict, db, dbRead, lock, capabilities: caps, labMetrics, faults, aws, awsCreds,
    storage, auth, cache, queue, images, inlineImages, workflow, notifier, email, scheduler, social, tagger,
    secrets: d.secrets, runtime, runtimeConfig, crypto, logger, loggerPort, metrics, tracer, analytics, directUpload, cdn,
    blocklist, lifecycle, detectors,
    startBackground() {
      if (backgroundStarted) return;
      backgroundStarted = true;
      caps.startProbeLoop({ intervalSec: 30, jitterSec: 5 });
      labMetrics.start();
      // 运行中（每 60 秒）：规则引擎的 runtime 范围，只产生 warn（例如 SEC-002 “用户绕过了 ALB”）
      loops.push(startLoop(async () => {
        const observed: RuntimeObservations = {};
        for (const det of detectors) {
          const o = det.observations?.();
          if (o) observed[det.module] = o;
        }
        const v = runRules(RULES, { cfg, env, layers, role, observed, lockScope: lock.scope }, { phases: ['runtime'] });
        caps.setRuntimeVerdict(v.warnings);
      }, { intervalSec: 60, jitterSec: 5 }));
    },
    async close() {
      caps.stopProbeLoop();
      for (const l of loops) l.stop();
      await labMetrics.stop().catch(() => undefined);
      await Promise.allSettled([queue.close?.(), cache.close?.(), analytics.close?.(), metrics.flush(), loggerPort.flush()]);
      if (dbRead !== db) await dbRead.destroy().catch(() => undefined);
      await db.destroy().catch(() => undefined);
      aws.destroy();
    },
  };
  logger.info('container ready', { role, modules: caps.summary() });
  return c;
}
