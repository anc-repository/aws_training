// caps.profile (04 §6.4, 02 §3.6 health gate): every module of the start profile has the expected driver and is healthy
// (degraded only because of the card's expectedWarnings); `*` = any driver (health only). Observation + judgement; the
// platform re-judges with the same rule.
import { capabilitySnapshot, healthy } from '../lib/caps.mjs';

export default async function capsProfile(args, ctx) {
  const expect = args.expect ?? {};
  const modules = Object.keys(expect);
  const r = await capabilitySnapshot(ctx, { modules, view: 'public' });
  const caps = r.data ?? {};
  const expected = new Set(args.expectedWarnings ?? []);
  const diffs = [];
  const hit = new Set();
  const seen = {};
  for (const [m, driver] of Object.entries(expect)) {
    const mod = caps.modules?.[m];
    seen[m] = mod ? { driver: mod.driver ?? null, status: mod.status ?? null } : null;
    const h = healthy(mod, caps.validation, m, expected);
    h.expectedHit.forEach((x) => hit.add(x));
    const driverOk = driver === '*' || mod?.driver === driver;
    if (!mod || !driverOk || !h.ok) diffs.push({ module: m, expected: driver, driver: mod?.driver ?? null, status: mod?.status ?? null, why: !driverOk ? 'driver' : h.why ?? 'unhealthy' });
  }
  return { modules: seen, validation: caps.validation ?? null, diffs, healthy: diffs.length === 0, expectedHit: [...hit] };
}
