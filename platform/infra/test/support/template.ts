/** Shared helpers of the template tests: one build of the merged template per test run. */
import { evaluateConditions, EXAMPLE_PSEUDO } from '../../build/intrinsics.js';
import { buildTemplate, EMPTY_MANIFEST, type ReleaseManifest } from '../../build/merge-template.js';
import { defaultParams } from '../../build/gen-policies.js';

export type Json = Record<string, unknown>;
export interface Resource {
  Type: string;
  Condition?: string;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  Properties?: Json;
}

let cached: Json | null = null;
export const TEST_MANIFEST: ReleaseManifest = {
  Files: [{ Name: 'atl-lambdas.zip', Sha256: 'a'.repeat(64), Size: 1 }],
  ChecksBundleDigest: 'b'.repeat(64),
};

export function template(): Json {
  cached ??= buildTemplate({ manifest: TEST_MANIFEST });
  return cached;
}

export function emptyManifestTemplate(): Json {
  return buildTemplate({ manifest: EMPTY_MANIFEST });
}

export function resources(): Record<string, Resource> {
  return template().Resources as Record<string, Resource>;
}

export function byType(type: string): [string, Resource][] {
  return Object.entries(resources()).filter(([, r]) => r.Type === type);
}

export function prop<T = unknown>(r: Resource, name: string): T {
  return (r.Properties ?? {})[name] as T;
}

/** Conditions evaluated with the default parameters (ap-northeast-1). */
export function defaultConditions(overrides: Record<string, string | string[]> = {}): Record<string, boolean> {
  return evaluateConditions(template().Conditions as Json, {
    params: { ...defaultParams(), LearnerEmail: 'learner@example.com', ...overrides },
    pseudo: { ...EXAMPLE_PSEUDO },
  });
}

/** Names of resources (by a name property) of a type, with their condition. */
export function named(type: string, nameProp: string): { id: string; name: unknown; condition?: string }[] {
  return byType(type).map(([id, r]) => ({ id, name: prop(r, nameProp), condition: r.Condition }));
}

/** All actions of a policy document (Statement may contain Fn::If wrappers). */
export function actionsOf(doc: unknown): string[] {
  const out: string[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(visit);
    else if (n && typeof n === 'object') {
      const o = n as Json;
      if ('Fn::If' in o) {
        const [, a, b] = o['Fn::If'] as unknown[];
        visit(a);
        visit(b);
        return;
      }
      if ('Effect' in o) {
        const a = o.Action;
        if (typeof a === 'string') out.push(a);
        else if (Array.isArray(a)) out.push(...(a as string[]));
        return;
      }
      if ('Statement' in o) visit(o.Statement);
    }
  };
  visit(doc);
  return out;
}
