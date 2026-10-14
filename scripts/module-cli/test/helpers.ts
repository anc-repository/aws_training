import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ModuleId } from '@cloudalbum/contracts';
import { fileURLToPath } from 'node:url';
import { CapturePrinter } from '../src/printer.js';
import { createContext, type Ctx, type GlobalOptions } from '../src/context.js';
import { DryRunGateway } from '../src/aws.js';
import { newState, type CloudAlbumState } from '../src/state.js';
import { IMPLEMENTED_MODULES, WAVE1_MODULES } from '../src/registry.js';
import { mainTemplatePath } from '../src/template.js';
import type { Deliverer, RemoteResult, RemoteScript } from '../src/deliver.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * wave1-prep: the wave 1 module templates (infra/modules/<id>.yaml) are written by the module implementers in parallel.
 * While this is true, template-based tests skip wave 1 modules whose template does not exist yet; the integration step sets
 * it to false so that every implemented module must have its template.
 */
export const ALLOW_PENDING_WAVE1_TEMPLATES = true;

/** Implemented modules whose main template exists (all of them once ALLOW_PENDING_WAVE1_TEMPLATES is false). */
export function modulesWithTemplates(): ModuleId[] {
  return IMPLEMENTED_MODULES.filter((id) => !ALLOW_PENDING_WAVE1_TEMPLATES || !WAVE1_MODULES.includes(id)
    || existsSync(path.join(REPO_ROOT, mainTemplatePath(id))));
}

/** Deliverer that records the scripts instead of running them. */
export class RecordingDeliverer implements Deliverer {
  readonly channel = 'ssh';
  readonly scripts: RemoteScript[] = [];
  constructor(readonly dryRun = true, private readonly reply: (s: RemoteScript) => RemoteResult = () => ({ code: 0, stdout: '', stderr: '' })) {}
  async run(script: RemoteScript): Promise<RemoteResult> {
    this.scripts.push(script);
    return this.reply(script);
  }
}

/** A state that looks like "base deployed" (values are documentation examples). */
export function deployedState(): CloudAlbumState {
  const s = newState('lab', 'ap-northeast-1');
  s.base = {
    stackName: 'cloudalbum-lab-ec2', instanceId: 'i-0123456789abcdef0', publicIp: '203.0.113.10',
    publicDnsName: 'ec2-203-0-113-10.ap-northeast-1.compute.amazonaws.com', securityGroupId: 'sg-0aaa', vpcId: 'vpc-0aaa',
    subnetId: 'subnet-0a', availabilityZone: 'ap-northeast-1a', dataVolumeId: 'vol-0aaa', arch: 'arm64',
    defaultSubnetIds: ['subnet-0a', 'subnet-0c', 'subnet-0d'], params: { AssociateEip: 'true', PublicHttpIngress: 'open' },
  };
  s.baseConfig = { AWS_REGION: 'ap-northeast-1', CLOUDALBUM_ENV: 'lab', APP_BASE_URL: 'http://203.0.113.10', DEPLOY_MODE: 'single' };
  return s;
}

export function dryContext(state: CloudAlbumState = deployedState(), opts: GlobalOptions = {}): {
  ctx: Ctx; out: CapturePrinter; aws: DryRunGateway; deliverer: RecordingDeliverer;
} {
  const out = new CapturePrinter();
  const aws = new DryRunGateway(out);
  const deliverer = new RecordingDeliverer(true);
  const ctx = createContext({ dryRun: true, yes: true, skipLocalCheck: true, state: path.join(REPO_ROOT, '.cloudalbum', 'never-written.json'), ...opts },
    { aws, out, deliverer, repoRoot: REPO_ROOT, state });
  return { ctx, out, aws, deliverer };
}
