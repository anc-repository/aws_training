// scripts/smoke/run.mjs —— 起一套 api + worker（指定档位的配置目录），跑全流程，停掉
import path from 'node:path';
import { runFlow } from './flow.mjs';
import { f14Flow } from './f14.mjs';
import { cleanup, freePort, makeEnvDir, ROOT, sleep, startProcess, tail, waitHealthy } from './lib.mjs';

/** 起一套 api + worker，跑全流程，停掉 */
export async function runVariant(t, key, v, { keep = false, base = {}, secrets = {}, beforeStart } = {}) {
  const port = await freePort();
  const env = makeEnvDir({ name: key, port, base, modules: v.modules, secrets });
  let api;
  let worker;
  try {
    if (beforeStart) await beforeStart(env);
    t.section(`${v.profile.name}：启动`);
    const started = await t.step(`api 进程启动（${env.baseUrl}）并通过 /api/health/ready`, async () => {
      api = startProcess('api', env, { root: env.root });
      await waitHealthy(env.baseUrl, api, 90_000);
      return path.relative(ROOT, env.root);
    });
    if (!started) return;
    await t.step('worker 进程启动并保持运行', async () => {
      worker = startProcess('worker', env, { root: env.root });
      for (let i = 0; i < 60; i++) {
        if (worker.child.exitCode !== null) throw new Error(`worker 已退出（exit ${worker.child.exitCode}）：\n${tail(worker.log)}`);
        if (/cloudalbum-worker started/.test(tail(path.join(env.data, 'logs', 'worker.log'), 200))) return 'cloudalbum-worker started';
        await sleep(250);
      }
      throw new Error(`15 秒内没有看到 worker 启动日志：\n${tail(worker.log)}`);
    });
    const state = await runFlow(t, env, v.profile);
    if (v.profile.f14) await f14Flow(t, env, v.profile, state);
    if (v.after) await v.after(t, env, state);
    await t.step('api / worker 日志中没有未处理的异常', async () => {
      const files = [api?.log, worker?.log, path.join(env.data, 'logs', 'api.log'), path.join(env.data, 'logs', 'worker.log')].filter(Boolean);
      const bad = files.flatMap((f) => tail(f, 5000).split(/\r?\n/)
        .filter((l) => /"level":"(error|fatal)"|Unhandled|uncaught/i.test(l))
        .map((l) => `${path.relative(env.root, f)}: ${l.slice(0, 300)}`));
      if (bad.length) throw new Error(bad.slice(0, 10).join('\n'));
      return '无 error 级日志';
    });
  } finally {
    await worker?.stop();
    await api?.stop();
    cleanup(env.root, keep);
  }
}
