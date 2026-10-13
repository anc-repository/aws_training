/**
 * Build-time metadata derived from the registry:
 *   - topological order of all modules (run-hostsetup.sh --all replays host artifacts in this order; release-meta)
 *   - registry.json for the release archive (run-hostsetup.sh reads it with jq on the instance)
 *   - the exact `location =` blocks of internalEndpoints in infra/nginx/cloudalbum_locations.conf (2.5 item 4)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isModuleId, type ModuleId } from '@cloudalbum/contracts';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { orderSteps } from './deps.js';
import { MODULE_IDS, REGISTRY, type Registry } from './registry.js';

/** dependency edges [dependency, dependent] derived from requires (module atoms and VAR=value owned by another module) */
export function registryEdges(registry: Registry = REGISTRY): Array<[ModuleId, ModuleId]> {
  const byVar = new Map<string, ModuleId>();
  for (const id of MODULE_IDS) { const v = registry[id]?.switch?.var; if (v) byVar.set(v, id); }
  const edges: Array<[ModuleId, ModuleId]> = [];
  for (const id of MODULE_IDS) {
    for (const r of registry[id]?.requires ?? []) {
      for (const n of r.need) {
        for (const atom of n.split('|').map((s) => s.trim())) {
          let dep: ModuleId | undefined;
          if (isModuleId(atom)) dep = atom;
          else {
            // VAR=value and VAR!=value on another module's switch both mean "that module first" (DEP-004: QUEUE_DRIVER!=sync)
            const m = /^([A-Z0-9_]+)!?=(.+)$/.exec(atom);
            if (m) dep = byVar.get(m[1]!);
          }
          if (dep && dep !== id) edges.push([dep, id]);
        }
      }
    }
    if (registry[id]?.credentials === 'required' && id !== 'iam') edges.push(['iam', id]);
  }
  return edges;
}

export function topologicalModules(registry: Registry = REGISTRY): ModuleId[] {
  return orderSteps(MODULE_IDS.map((module) => ({ module })), registryEdges(registry), registry).map((s) => s.module);
}

export function writeReleaseMeta(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const reg = path.join(outDir, 'registry.json');
  const order = path.join(outDir, 'hostsetup-order.txt');
  writeFileSync(reg, `${JSON.stringify(REGISTRY_DOCUMENT, null, 2)}\n`);
  writeFileSync(order, `${topologicalModules().join('\n')}\n`);
  return [reg, order];
}

const BEGIN = '# BEGIN internal-endpoints';
const END = '# END internal-endpoints';

/** location blocks generated from registry internalEndpoints (public-hmac / vpc-hmac) */
export function renderInternalEndpoints(registry: Registry = REGISTRY): string {
  const lines: string[] = [];
  for (const id of MODULE_IDS) {
    for (const e of registry[id]?.internalEndpoints ?? []) {
      if (e.exposure === 'public-hmac') {
        lines.push(`location = ${e.path} { include /etc/nginx/cloudalbum_proxy.conf; }   # ${id}, public-hmac (${e.secret})`);
      } else {
        lines.push(`location = ${e.path} { include /etc/nginx/cloudalbum-vpc-cidr.inc; deny all;   # ${id}, vpc-hmac (${e.secret})`,
          `${' '.repeat(`location = ${e.path} { `.length)}include /etc/nginx/cloudalbum_proxy.conf; }`);
      }
    }
  }
  return lines.join('\n');
}

export function locationsFile(repoRoot: string): string {
  return path.join(repoRoot, 'infra', 'nginx', 'cloudalbum_locations.conf');
}

/** returns { current, expected } of the generated block */
export function internalEndpointsBlock(repoRoot: string): { current: string; expected: string; text: string } {
  const text = readFileSync(locationsFile(repoRoot), 'utf8');
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error(`${locationsFile(repoRoot)}: markers "${BEGIN}" / "${END}" missing`);
  const current = text.slice(a + BEGIN.length, b).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return { current, expected: renderInternalEndpoints(), text };
}

export function writeInternalEndpoints(repoRoot: string): boolean {
  const { current, expected, text } = internalEndpointsBlock(repoRoot);
  if (current === expected) return false;
  const a = text.indexOf(BEGIN) + BEGIN.length;
  const b = text.indexOf(END);
  writeFileSync(locationsFile(repoRoot), `${text.slice(0, a)}\n${expected}\n${text.slice(b)}`);
  return true;
}
