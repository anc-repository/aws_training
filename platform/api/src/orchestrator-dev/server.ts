/**
 * Dev server with the lifecycle wired in (ATL_DEV_MODE=1): the scaffold's dev server plus `installLifecycleDev`.
 *
 *   npx tsx platform/api/src/orchestrator-dev/server.ts --dev-mode
 *
 * Same endpoints as src/dev/server.ts (/api/v1/*, /__dev/*). The dev runtime now installs the lifecycle itself
 * (`createDevRuntime` → `installLifecycleDev`), so this entry is kept only as an alias of `npm run platform:dev`.
 */
import http from 'node:http';
// eslint-disable-next-line no-restricted-imports -- dev-only entry (orchestrator-dev is never bundled)
import { loadDevConfig } from '../dev/config.js';
// eslint-disable-next-line no-restricted-imports -- dev-only entry
import { createDevRuntime } from '../dev/runtime.js';
// eslint-disable-next-line no-restricted-imports -- dev-only entry
import { handleDevRequest } from '../dev/server.js';

async function main(): Promise<void> {
  if (process.argv.includes('--dev-mode')) process.env.ATL_DEV_MODE = '1';
  if (process.env.ATL_DEV_MODE !== '1') {
    console.error('set ATL_DEV_MODE=1 (or pass --dev-mode)');
    process.exit(2);
  }
  const cfg = loadDevConfig();
  const rt = await createDevRuntime(cfg);
  const server = http.createServer((req, res) => {
    handleDevRequest(rt, req, res).catch((e: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    });
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`ATL dev server (lifecycle wired) on http://127.0.0.1:${cfg.port}  (DynamoDB ${cfg.ddbEndpoint}, time x${cfg.timeScale}, runner ${cfg.runnerMode})`);
  });
  const stop = async () => {
    server.close();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && /orchestrator-dev[\\/]server\.(ts|js)$/.test(process.argv[1])) void main();
