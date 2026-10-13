/**
 * Tags — 01 §3.9 “标签” (name-table row “标签”).
 */

export const TAG_KEYS = {
  sessionId: 'atl:session-id',
  labId: 'atl:lab-id',
  envId: 'atl:env-id',
  project: 'Project',
  component: 'atl:component',
  role: 'atl:role',
  activeSessionId: 'atl:active-session-id',
  cardStack: 'atl:card-stack',
} as const;
export type TagKey = (typeof TAG_KEYS)[keyof typeof TAG_KEYS];

export const PROJECT_VALUES = { session: 'CloudAlbum', platform: 'ATL' } as const;
export const COMPONENT_VALUES = ['platform', 'workstation', 'env', 'lab-state'] as const;
export type ComponentValue = (typeof COMPONENT_VALUES)[number];
/** Learners may set `env` but not `platform` / `workstation` (ProtectComponentTag). */
export const LEARNER_SETTABLE_COMPONENT_VALUES = ['env'] as const satisfies readonly ComponentValue[];
export const INSTANCE_ROLE_VALUES = ['lab-app', 'workstation'] as const;
export type InstanceRoleValue = (typeof INSTANCE_ROLE_VALUES)[number];

/** Session tag keys that learners may set but not remove (KeepAtlTags). */
export const SESSION_TAG_KEYS = [TAG_KEYS.sessionId, TAG_KEYS.labId, TAG_KEYS.envId] as const;

/** AWS reserved tag used to verify that a discovered instance belongs to this environment (01 §9.8). */
export const CFN_STACK_NAME_TAG = 'aws:cloudformation:stack-name';

/** Environment-level tags (`Environment.platformTags` + session tags) applied to every CloudAlbum stack in platform mode. */
export function environmentStackTags(input: { envId: string; sessionId: string; labId: string }): Record<string, string> {
  return {
    [TAG_KEYS.component]: 'env',
    [TAG_KEYS.envId]: input.envId,
    [TAG_KEYS.sessionId]: input.sessionId,
    [TAG_KEYS.labId]: input.labId,
    [TAG_KEYS.project]: PROJECT_VALUES.session,
  };
}

/** `CLOUDALBUM_PLATFORM_TAGS` format: `key=value` joined by commas, keys sorted for determinism. */
export function formatPlatformTags(tags: Record<string, string>): string {
  return Object.keys(tags)
    .sort()
    .map((k) => {
      const v = tags[k]!;
      if (/[,=]/.test(k) || /[,]/.test(v)) throw new TypeError(`tag ${k}=${v} cannot be encoded (',' or '=' in key, ',' in value)`);
      return `${k}=${v}`;
    })
    .join(',');
}

export function parsePlatformTags(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) throw new TypeError(`invalid tag pair: ${part}`);
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}
