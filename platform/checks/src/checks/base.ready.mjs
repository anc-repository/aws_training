// base.ready (04 §6.4, 02 health gate): L0 ready — read from `cloudalbum platform-status --json` (06 PM-02).
import { CheckError } from '../lib/context.mjs';
import { probe } from '../lib/http.mjs';

export default async function baseReady(_args, ctx) {
  let s;
  try {
    s = await ctx.cli(['platform-status', '--json']);
  } catch (e) {
    if (!ctx.dev || !(e instanceof CheckError)) throw e;
    // dev without the platform-mode CLI: only the local api health is known
    let live = false;
    try {
      live = (await probe({ url: `${ctx.appBaseUrl}/api/health/live`, timeoutMs: 3000 }))[0].status === 200;
    } catch {
      live = false;
    }
    return { services: { api: live ? 'active' : 'inactive', worker: 'unknown', nginx: 'unknown' }, dataVolumeMounted: true, platformEnvPresent: false, probeTokenPresent: ctx.localProbeToken() !== null, localHealth: live ? 'ok' : 'error', dev: true };
  }
  const services = s.services ?? {};
  const allActive = ['api', 'worker', 'nginx'].every((k) => services[k] === 'active');
  return {
    services,
    dataVolumeMounted: s.dataVolumeMounted === true,
    platformEnvPresent: s.platformEnv?.present === true && s.platformEnv?.valid === true,
    probeTokenPresent: s.probeToken?.present === true,
    localHealth: allActive ? 'ok' : 'degraded',
    platformMode: s.platformMode ?? null,
    checkBundle: s.checkBundle ?? null,
    ssmAgent: s.ssmAgent ?? null,
    session: s.session ?? null,
  };
}
