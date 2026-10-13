#!/usr/bin/env node
// backend/src/cli.ts —— 实例上的命令行（node dist/cli.js <command>；以 cloudalbum 用户、CLOUDALBUM_ENV_DIR=/etc/cloudalbum 运行）
//
// 子命令在此统一登记（总纲 4.5、§11）：
//   check-config            启动配置校验（分层加载 + zod + 规则引擎）；通过 0，未通过 78（--plan 额外运行部署范围的规则）
//   db:migrate              执行数据库迁移（双方言）
//   admin:create            创建管理员（--email，可选 --password；不提供时生成并打印）
//   admin:ensure            没有任何管理员时才创建（l0-bootstrap.sh：--print-password-if-created）
//   probe [module]          运行一次探针（--deep 深度探针），打印各模块状态
//   keys:fingerprint        打印 LOCAL_MASTER_KEY 的指纹（scripts/module 在替换实例前后比对）
//   keys:check-fingerprint  与数据库 system_meta 中的记录比对，不一致退出 78（CFG-007）
//   keys:reset-fingerprint  --confirm-data-loss：主密钥已重新生成时清空无法解密的字段并记录新指纹（postattach --regenerate-secrets）
//   dev:init                在开发机上生成本地运行目录（.cloudalbum/dev：env、机密、ES256 密钥、数据目录）
//   job run <name>          手动执行一次定时任务（trigger=manual；与 worker 同一份注册表与锁）
//   lab:compact             把 2 天前的 lab_metric_rollups 压缩为小时级
//   migrate-module          已登记，由后续实现者填充（scripts/migrate）
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { MODULE_IDS, isModuleId, type ModuleId } from '@cloudalbum/contracts';
import { buildContainer, type Container } from './container.js';
import { checkKeyFingerprint, currentKeyFingerprint, resetKeyFingerprint } from './config/key-fingerprint.js';
import { DEFAULT_ENV_DIR, validateConfig } from './config/validate.js';
import { createKnex, migrateLatest } from './db/knex.js';
import { ConfigValidationError, EX_CONFIG } from './errors.js';
import { DEFAULT_RUNTIME_CONFIG } from './ports/config.js';
import { secretEnvName } from './ports/secrets.js';
import { registerScheduledJobs, bindJobs } from './jobs/index.js';
import type { ScheduledJobName } from './ports/scheduler.js';
import { compactRollups } from './repositories/lab.js';
import { countAdmins, findUserByEmail, insertUser } from './repositories/users.js';
import { printConfigReport } from './rules/engine.js';

function envDirOf(opts: { envDir?: string }): string {
  return opts.envDir ?? process.env.CLOUDALBUM_ENV_DIR ?? DEFAULT_ENV_DIR;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function withContainer<T>(opts: { envDir?: string }, fn: (c: Container) => Promise<T>, probeOnStart = false): Promise<T> {
  const c = await buildContainer('cli', { envDir: envDirOf(opts), probeOnStart, autoMigrate: false });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

async function hashPassword(password: string): Promise<string> {
  const argon2 = await import('@node-rs/argon2');
  const hash = (argon2 as { hash?: typeof argon2.hash }).hash ?? (argon2 as unknown as { default: typeof argon2 }).default.hash;
  return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function buildProgram(): Command {
  const program = new Command('cloudalbum')
    .description('CloudAlbum 实例命令行（node dist/cli.js）')
    .showHelpAfterError();
  const envDirOption = () => new Option('--env-dir <dir>', '配置目录（默认 $CLOUDALBUM_ENV_DIR 或 /etc/cloudalbum）');

  program.command('check-config')
    .description('校验启动配置：分层加载 + zod + 规则引擎；通过返回 0，未通过返回 78')
    .addOption(envDirOption())
    .option('--plan', '计划模式：额外运行部署范围（deploy）的规则（scripts/module enable/disable 的第 1 步）')
    .addOption(new Option('--role <role>', '以哪个进程角色校验').choices(['api', 'worker', 'cli']).default('api'))
    .option('--json', '以 JSON 输出')
    .action(async (opts: { envDir?: string; plan?: boolean; role: 'api' | 'worker' | 'cli'; json?: boolean }) => {
      const v = await validateConfig({ role: opts.role, envDir: envDirOf(opts), phases: opts.plan ? ['startup', 'deploy'] : ['startup'] });
      if (opts.json) {
        out(JSON.stringify({ ok: v.ok, envDir: v.layers.envDir, envDirExists: v.layers.exists,
          parseErrors: v.parsed.errors, ...v.verdict }, null, 2));
      } else {
        if (!v.layers.exists) out(`注意：配置目录 ${v.layers.envDir} 不存在，全部取默认值（L0 本地实现）`);
        printConfigReport(v.parsed.errors, v.verdict, (l) => out(l));
      }
      process.exitCode = v.ok ? 0 : EX_CONFIG;
    });

  program.command('db:migrate')
    .description('执行数据库迁移（SQLite / PostgreSQL 双方言）')
    .addOption(envDirOption())
    .action(async (opts: { envDir?: string }) => {
      const v = await validateConfig({ role: 'cli', envDir: envDirOf(opts) });
      if (!v.ok || !v.parsed.config) {
        printConfigReport(v.parsed.errors, v.verdict, (l) => process.stderr.write(`${l}\n`));
        process.exitCode = EX_CONFIG;
        return;
      }
      const cfg = v.parsed.config;
      // 迁移只需要数据库连接；DB_PASSWORD 来自 secrets.env（分层合并结果），不经 SecretsPort
      const db = await createKnex(cfg);
      try {
        const done = await migrateLatest(db, { auditRetentionDays: cfg.core.AUDIT_RETENTION_DAYS });
        out(done.length ? `db:migrate 完成：${done.join(', ')}` : 'db:migrate：已是最新');
      } finally {
        await db.destroy();
      }
    });

  const createAdmin = async (opts: { envDir?: string; email: string; password?: string; displayName?: string; onlyIfNone?: boolean;
    printPassword?: boolean }) => {
    const v = await validateConfig({ role: 'cli', envDir: envDirOf(opts) });
    if (!v.ok || !v.parsed.config) {
      printConfigReport(v.parsed.errors, v.verdict, (l) => process.stderr.write(`${l}\n`));
      process.exitCode = EX_CONFIG;
      return;
    }
    const db = await createKnex(v.parsed.config);
    try {
      if (opts.onlyIfNone && (await countAdmins(db)) > 0) return;          // 幂等判断查数据库，不依赖根卷上的文件
      if (await findUserByEmail(db, opts.email)) {
        process.stderr.write(`用户 ${opts.email} 已存在\n`);
        process.exitCode = opts.onlyIfNone ? 0 : 1;
        return;
      }
      const password = opts.password ?? generatePassword();
      await insertUser(db, {
        email: opts.email, displayName: opts.displayName ?? 'admin', passwordHash: await hashPassword(password),
        role: 'admin', emailVerified: true,
      });
      if (opts.printPassword || !opts.password) out(password);
      else out(`管理员 ${opts.email} 已创建`);
    } finally {
      await db.destroy();
    }
  };

  program.command('admin:create')
    .description('创建管理员账号（auth=local）')
    .addOption(envDirOption())
    .requiredOption('--email <email>', '管理员邮箱')
    .option('--password <password>', '初始密码（省略时生成并打印）')
    .option('--display-name <name>', '显示名')
    .action((opts: { envDir?: string; email: string; password?: string; displayName?: string }) => createAdmin(opts));

  program.command('admin:ensure')
    .description('没有任何管理员时才创建（l0-bootstrap.sh 使用）')
    .addOption(envDirOption())
    .requiredOption('--email <email>', '管理员邮箱')
    .option('--print-password-if-created', '只在本次真的新建了管理员时打印初始密码')
    .action((opts: { envDir?: string; email: string; printPasswordIfCreated?: boolean }) =>
      createAdmin({ ...opts, onlyIfNone: true, printPassword: Boolean(opts.printPasswordIfCreated) }));

  program.command('probe [module]')
    .description('运行一次探针并打印各模块状态（--deep 深度探针）')
    .addOption(envDirOption())
    .option('--deep', '深度探针')
    .option('--json', '以 JSON 输出完整的管理员视图')
    .option('--fail-on-error', '有模块为 error 时退出码 1')
    .action(async (module: string | undefined, opts: { envDir?: string; deep?: boolean; json?: boolean; failOnError?: boolean }) => {
      if (module && !isModuleId(module)) {
        process.stderr.write(`未知模块：${module}（可选：${MODULE_IDS.join(', ')}）\n`);
        process.exitCode = 2;
        return;
      }
      await withContainer(opts, async (c) => {
        if (module) await c.capabilities.probeModule(module as ModuleId, { ...(opts.deep ? { deep: true } : {}), timeoutMs: 5000 });
        else await c.capabilities.probeAll({ ...(opts.deep ? { deep: true } : {}), timeoutMs: 5000 });
        const snap = c.capabilities.snapshot('admin');
        if (opts.json) {
          out(JSON.stringify(module ? snap.modules[module as ModuleId] : snap, null, 2));
        } else {
          for (const id of module ? [module as ModuleId] : MODULE_IDS) {
            const m = snap.modules[id];
            const st = m.status === 'off' ? `off/${m.localHealth ?? 'ok'}` : m.status;
            out(`${id.padEnd(17)} ${m.driver.padEnd(14)} ${st.padEnd(12)} ${m.detail}`);
          }
        }
        const anyError = Object.values(snap.modules).some((m) => m.status === 'error' || m.localHealth === 'error');
        if (opts.failOnError && anyError) process.exitCode = 1;
      });
    });

  program.command('keys:fingerprint')
    .description('打印 LOCAL_MASTER_KEY 的指纹')
    .addOption(envDirOption())
    .action(async (opts: { envDir?: string }) => {
      await withContainer(opts, async (c) => {
        const fp = await currentKeyFingerprint(c.secrets);
        if (!fp) {
          process.stderr.write('无法读取 local-master-key（SecretsPort 未实现或 LOCAL_MASTER_KEY 未配置）\n');
          process.exitCode = 1;
          return;
        }
        out(fp);
      });
    });

  program.command('keys:check-fingerprint')
    .description('与数据库 system_meta 中的指纹比对，不一致退出 78（CFG-007）')
    .addOption(envDirOption())
    .action(async (opts: { envDir?: string }) => {
      await withContainer(opts, async (c) => {
        const r = await checkKeyFingerprint(c.db, c.secrets, c.logger);
        out(r.status === 'skipped' ? `skipped：${r.reason}` : `${r.status}：${r.fingerprint}`);
      });
    });

  program.command('keys:reset-fingerprint')
    .description('放弃旧主密钥下的全部加密字段（MFA 密钥、照片位置）并记录新 LOCAL_MASTER_KEY 的指纹；必须带 --confirm-data-loss')
    .addOption(envDirOption())
    .option('--confirm-data-loss', '确认：已加密字段将被清空（开启 MFA 的用户需要重新绑定）')
    .action(async (opts: { envDir?: string; confirmDataLoss?: boolean }) => {
      if (!opts.confirmDataLoss) {
        process.stderr.write('拒绝执行：这会清空所有无法再解密的字段。确认后加上 --confirm-data-loss\n');
        process.exitCode = 2;
        return;
      }
      // 不经 buildContainer（它会先做 CFG-007 比对并拒绝启动）；主密钥直接取分层 env 中的 LOCAL_MASTER_KEY（secrets=env）
      const v = await validateConfig({ role: 'cli', envDir: envDirOf(opts) });
      if (!v.ok || !v.parsed.config) {
        printConfigReport(v.parsed.errors, v.verdict, (l) => process.stderr.write(`${l}\n`));
        process.exitCode = EX_CONFIG;
        return;
      }
      const key = v.layers.merged[secretEnvName('local-master-key')] ?? '';
      if (!key) {
        process.stderr.write('LOCAL_MASTER_KEY 不在分层 env 中（secrets.env）：无法记录新指纹\n');
        process.exitCode = 1;
        return;
      }
      const db = await createKnex(v.parsed.config);
      try {
        const r = await resetKeyFingerprint(db, key);
        out(r.status === 'match'
          ? `match：${r.fingerprint}（指纹已一致，未改动任何数据）`
          : `reset：${r.previous ?? '(无)'} → ${r.fingerprint} · 清空 MFA 密钥 ${r.cleared.mfaUsers} 个（这些用户的 MFA 已关闭）、` +
            `照片位置 ${r.cleared.photoLocations} 条、进行中的 MFA 挑战 ${r.cleared.mfaChallenges} 个`);
      } finally {
        await db.destroy();
      }
    });

  program.command('dev:init')
    .description('开发机：生成本地运行目录（env、机密、ES256 密钥、数据目录），之后设置 CLOUDALBUM_ENV_DIR=<dir>/etc')
    .option('--dir <dir>', '目标目录', '.cloudalbum/dev')
    .option('--port <port>', 'APP_BASE_URL 的端口', '3000')
    .action((opts: { dir: string; port: string }) => {
      const root = path.resolve(opts.dir).replace(/\\/g, '/');
      const etc = `${root}/etc`;
      const data = `${root}/data`;
      for (const d of [etc, `${etc}/keys`, `${etc}/modules.d`, `${etc}/tls`, `${root}/run`,
        ...['db', 'uploads/.incoming', 'outbox', 'logs/spans', 'security', 'migrate', 'lab', 'backup'].map((s) => `${data}/${s}`)]) {
        mkdirSync(d, { recursive: true });
      }
      const write = (file: string, content: string) => {
        if (existsSync(file)) {
          out(`保留已有文件 ${file}`);
          return;
        }
        writeFileSync(file, content, { encoding: 'utf8', mode: 0o640 });
        out(`写入 ${file}`);
      };
      write(`${etc}/cloudalbum.env`, [
        '# 开发机的基础配置（npm run dev:init 生成）；其余开关缺省 = 本地实现 = L0',
        'AWS_REGION=ap-northeast-1',
        'CLOUDALBUM_ENV=lab',
        `APP_BASE_URL=http://localhost:${opts.port}`,
        'DEPLOY_MODE=single',
        `CLOUDALBUM_DATA_DIR=${data}`,
        `LOCK_FILE_DIR=${root}/run`,
        `PORT=${opts.port}`,
        '',
      ].join('\n'));
      const key = () => randomBytes(32).toString('base64');
      write(`${etc}/secrets.env`, [
        'SECRETS_ORIGIN=instance',
        `UPLOAD_HMAC_KEY=${key()}`,
        `MEDIA_HMAC_KEY=${key()}`,
        `CALLBACK_HMAC_KEY=${key()}`,
        `INTERNAL_HMAC_KEY=${key()}`,
        `COOKIE_SECRET=${key()}`,
        `LOCAL_MASTER_KEY=${key()}`,
        `JWT_SIGNING_KEY_FILE=${etc}/keys/jwt-es256.pem`,
        '',
      ].join('\n'));
      if (!existsSync(`${etc}/keys/jwt-es256.pem`)) {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' } });
        writeFileSync(`${etc}/keys/jwt-es256.pem`, privateKey, { encoding: 'utf8', mode: 0o640 });
        out(`写入 ${etc}/keys/jwt-es256.pem`);
      }
      write(`${etc}/runtime.json`, `${JSON.stringify(DEFAULT_RUNTIME_CONFIG, null, 2)}\n`);
      out('');
      out('完成。在当前 shell 中设置：');
      out(`  bash:        export CLOUDALBUM_ENV_DIR=${etc} NODE_ENV=development`);
      out(`  PowerShell:  $env:CLOUDALBUM_ENV_DIR='${etc}'; $env:NODE_ENV='development'`);
      out('然后：npm run check-config；npm run dev --workspace @cloudalbum/backend');
    });

  const todo = (name: string) => () => {
    process.stderr.write(`${name}：尚未实现（脚手架登记的子命令）\n`);
    process.exitCode = 2;
  };
  program.command('migrate-module <id> <direction>')
    .description('模块数据迁移：up | down | verify（scripts/migrate/<id>，总纲 9.3）')
    .option('--dry-run').option('--resume').option('--prune-source')
    .action(todo('migrate-module'));
  program.command('job')
    .description('定时任务')
    .command('run <name>')
    .description('手动执行一次定时任务（trigger=manual）')
    .addOption(envDirOption())
    .action(async (name: string, opts: { envDir?: string }) => {
      await withContainer(opts, async (c) => {
        bindJobs(c);
        registerScheduledJobs(c);
        const run = await c.scheduler.triggerNow(name as ScheduledJobName);
        out(JSON.stringify(run));
        if (run.status === 'failed') process.exitCode = 1;
      });
    });
  program.command('lab:compact')
    .description('把 2 天前的 lab_metric_rollups 压缩为小时级')
    .addOption(envDirOption())
    .option('--days <n>', '压缩多少天以前的分钟级汇总', '2')
    .action(async (opts: { envDir?: string; days: string }) => {
      await withContainer(opts, async (c) => {
        const r = await compactRollups(c.db, new Date(Date.now() - Number(opts.days) * 86_400_000));
        out(`lab:compact：${r.minuteRows} 行分钟级 → ${r.hourRows} 行小时级`);
      });
    });

  return program;
}

const program = buildProgram();
try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof ConfigValidationError) {
    process.stderr.write(`${e.report}\n`);
    process.exit(EX_CONFIG);
  }
  process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`);
  process.exit(1);
}
