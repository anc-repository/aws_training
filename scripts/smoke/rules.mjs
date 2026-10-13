// scripts/smoke/rules.mjs —— 规则引擎自测：不合法的配置组合必须以退出码 78（EX_CONFIG）拒绝，并给出可读的报告
//
// 每个用例写一套配置目录（与 EC2 上 scripts/module 写出的 modules.d/*.env 同构），然后：
//   ① node backend/dist/cli.js check-config        → 退出码 78，报告中出现期望的规则 ID 与“修复：”提示；
//   ② node backend/dist/server.js（以及 worker.js） → 进程以 78 退出（systemd 的 RestartPreventExitStatus=78），不监听端口。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { BACKEND_DIST, check, childEnv, cleanup, cli, freePort, makeEnvDir, ROOT } from './lib.mjs';

const SQS = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012';

export const RULE_CASES = [
  {
    key: 'lambda-local-storage',
    title: 'IMAGE_PROCESSOR=lambda 而 STORAGE_DRIVER=local',
    expect: ['DEP-003'],
    modules: {
      iam: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'role' },
      'image-processing': {
        MODULE_IMAGE_PROCESSING: 'on', IMAGE_PROCESSOR: 'lambda', IMAGE_LAMBDA_FUNCTION: 'cloudalbum-lab-image-thumbnail',
        IMAGE_CALLBACK_URL: 'https://203.0.113.10/internal/hooks/image-processed', IMAGE_FAILURE_QUEUE_URL: `${SQS}/cloudalbum-lab-image-failures`,
      },
    },
    processes: ['api', 'worker'],
  },
  {
    key: 'asg-sqlite',
    title: 'DEPLOY_MODE=asg 而 DB_DRIVER=sqlite',
    expect: ['ASG-002'],
    modules: { autoscaling: { MODULE_AUTOSCALING: 'on', DEPLOY_MODE: 'asg' } },
    processes: ['api'],
  },
  {
    key: 'aws-module-without-iam',
    title: '启用了 AWS 模块（queue=sqs）但 IAM_CREDENTIALS=none',
    expect: ['CRED-001'],
    modules: { queue: { MODULE_QUEUE: 'on', QUEUE_DRIVER: 'sqs', SQS_QUEUE_URL: `${SQS}/cloudalbum-lab-jobs`, SQS_DLQ_URL: `${SQS}/cloudalbum-lab-jobs-dlq` } },
    processes: ['api', 'worker'],
  },
  {
    key: 'storage-s3-without-iam',
    title: '启用了 storage=s3 但 IAM_CREDENTIALS=none',
    expect: ['CRED-001'],
    modules: { storage: { MODULE_STORAGE: 'on', STORAGE_DRIVER: 's3', STORAGE_S3_RAW_BUCKET: 'cloudalbum-lab-raw', STORAGE_S3_MEDIA_BUCKET: 'cloudalbum-lab-media' } },
  },
  {
    key: 'unimplemented-driver',
    title: '配置了本轮未实现的驱动（SOCIAL_DRIVER=dynamodb）',
    expect: ['CFG-001'],
    expectText: ['尚未实现'],
    modules: { iam: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'role' }, 'social-store': { MODULE_SOCIAL_STORE: 'on', SOCIAL_DRIVER: 'dynamodb', SOCIAL_DDB_TABLE: 'cloudalbum-lab-social' } },
    processes: ['api'],
  },
  {
    key: 'foreign-key-in-module-file',
    title: 'modules.d/cache.env 中出现别的模块的键（DB_HOST）',
    expect: ['CFG-002'],
    modules: { cache: { CACHE_DRIVER: 'memory', DB_HOST: '127.0.0.1' } },
  },
  {
    key: 'half-enabled',
    title: 'MODULE_STORAGE=on 但 STORAGE_DRIVER 仍为本地值（半启用）',
    expect: ['CFG-004'],
    modules: { storage: { MODULE_STORAGE: 'on', STORAGE_DRIVER: 'local' } },
  },
];

function runToExit(script, etc, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BACKEND_DIST, script)], {
      cwd: ROOT, env: childEnv({ CLOUDALBUM_ENV_DIR: etc, NODE_ENV: 'development' }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export async function runRules(t, { keep = false } = {}) {
  t.section('规则引擎：不合法的配置组合 → 退出码 78');
  for (const rc of RULE_CASES) {
    const env = makeEnvDir({ name: `rules-${rc.key}`, port: await freePort(), modules: rc.modules });
    try {
      await t.step(`${rc.title} → check-config 退出 78（${rc.expect.join('、')}）`, async () => {
        const r = cli(env.etc, ['check-config']);
        const text = `${r.stdout}\n${r.stderr}`;
        check(r.status === 78, `check-config 退出码 ${r.status}（期望 78）：\n${text.slice(0, 800)}`);
        for (const id of rc.expect) check(text.includes(id), `报告中没有 ${id}：\n${text.slice(0, 800)}`);
        for (const s of rc.expectText ?? []) check(text.includes(s), `报告中没有“${s}”：\n${text.slice(0, 800)}`);
        check(/修复|scripts\/module|改回/.test(text), `报告缺少修复提示：\n${text.slice(0, 800)}`);
        const json = cli(env.etc, ['check-config', '--json']);
        const parsed = JSON.parse(json.stdout);
        check(parsed.ok === false, 'check-config --json 的 ok 应为 false');
        const first = text.split('\n').find((l) => rc.expect.some((id) => l.includes(id))) ?? '';
        return first.trim().slice(0, 160);
      });
      for (const proc of rc.processes ?? []) {
        await t.step(`${rc.title} → ${proc} 进程以 78 退出`, async () => {
          const r = await runToExit(proc === 'api' ? 'server.js' : 'worker.js', env.etc);
          check(r.code === 78, `${proc} 退出码 ${r.code}（期望 78）：\n${r.out.slice(0, 800)}`);
          check(rc.expect.every((id) => r.out.includes(id)), `${proc} 的报告中没有 ${rc.expect.join('、')}`);
          return `exit ${r.code}`;
        });
      }
    } finally {
      cleanup(env.root, keep);
    }
  }
}
