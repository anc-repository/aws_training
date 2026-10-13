/**
 * Dev registry of local “environments”: what the dev runner created for an envId (a local L0 base URL in `local-l0`
 * mode) and the fake instance ids that stand in for the lab instance and the workstation. ATL-RunCheck in dev looks the
 * instance id up here to find the CloudAlbum it should probe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { envNameFromEnvId, isEnvId } from '@atl/shared';

export interface DevEnvRecord {
  envId: string;
  envName: string;
  /** Local CloudAlbum (`local-l0` runner mode) or null. */
  baseUrl: string | null;
  instances: { lab: string; workstation: string };
  /** Directory of the local L0 instance (config, data, logs). */
  root: string | null;
  updatedAt: string;
}

export function devInstanceIds(envName: string): { lab: string; workstation: string } {
  return { lab: `i-dev-${envName}-lab`, workstation: `i-dev-${envName}-ws` };
}

export class DevEnvRegistry {
  constructor(private readonly dir: string) {}

  private file(envId: string): string {
    if (!isEnvId(envId)) throw new TypeError(`invalid envId: ${envId}`);
    return path.join(this.dir, `${envId}.json`);
  }

  get(envId: string): DevEnvRecord | null {
    const f = this.file(envId);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as DevEnvRecord) : null;
  }

  upsert(envId: string, patch: Partial<Omit<DevEnvRecord, 'envId'>> = {}): DevEnvRecord {
    const envName = patch.envName ?? this.get(envId)?.envName ?? envNameFromEnvId(envId);
    const rec: DevEnvRecord = {
      envId,
      envName,
      baseUrl: null,
      instances: devInstanceIds(envName),
      root: null,
      ...this.get(envId),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(envId), JSON.stringify(rec, null, 2));
    return rec;
  }

  remove(envId: string): void {
    fs.rmSync(this.file(envId), { force: true });
  }

  list(): DevEnvRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as DevEnvRecord);
  }

  byInstance(instanceId: string): DevEnvRecord | null {
    return this.list().find((r) => r.instances.lab === instanceId || r.instances.workstation === instanceId) ?? null;
  }
}
