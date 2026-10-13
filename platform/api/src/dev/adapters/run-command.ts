/**
 * Dev SSM Run Command. Documents are handled locally:
 *  - `ATL-RunCheck`: parameters are checked against the document's allowedPattern (04 §6.1), then the check runner
 *    (`ATL_DEV_CHECK_RUNNER`, the runner.mjs of the check bundle built by the CloudAlbum platform-mode implementer) runs as
 *    a local Node process with `SSM_<name>` variables — exactly like `/opt/atl/bin/atl-check` on the instance — plus
 *    `ATL_DEV_APP_BASE_URL` pointing at the local CloudAlbum of that environment.
 *  - `ATL-WorkstationSetup`: there is no workstation in dev; the call succeeds and reports that wiring was simulated.
 * Other documents fail. Handlers can be replaced with `registerDocument()`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  PortError,
  RUN_CHECK_PARAMETER_PATTERNS,
  RUN_CHECK_PARAMETERS,
  type ClockPort,
  type CommandInvocation,
  type RunCommandPort,
  type SendCommandRequest,
  type SsmDocumentName,
} from '@atl/shared';
import type { DevEnvRegistry } from './envs.js';

export type DevDocumentHandler = (
  req: SendCommandRequest,
  instanceId: string,
) => Promise<Pick<CommandInvocation, 'status' | 'responseCode' | 'stdout' | 'stderr'>>;

export interface LocalRunCommandOptions {
  clock: ClockPort;
  envs: DevEnvRegistry;
  checkRunner: string | null;
  repoRoot: string;
}

export class LocalRunCommand implements RunCommandPort {
  private readonly invocations = new Map<string, CommandInvocation>();
  private readonly documents = new Map<SsmDocumentName, DevDocumentHandler>();
  private seq = 0;

  constructor(private readonly o: LocalRunCommandOptions) {
    this.documents.set('ATL-RunCheck', (req, id) => this.runCheck(req, id));
    this.documents.set('ATL-WorkstationSetup', async () => ({
      status: 'Success',
      responseCode: 0,
      stdout: 'dev: workstation wiring simulated (ATL_DEV_MODE has no workstation instance)\n',
      stderr: '',
    }));
  }

  registerDocument(name: SsmDocumentName, handler: DevDocumentHandler): void {
    this.documents.set(name, handler);
  }

  async sendCommand(req: SendCommandRequest): Promise<{ commandId: string }> {
    if (req.documentName === 'ATL-RunCheck') {
      for (const [k, v] of Object.entries(req.parameters)) {
        const re = RUN_CHECK_PARAMETER_PATTERNS[k as (typeof RUN_CHECK_PARAMETERS)[number]];
        if (!re) throw new PortError('InvalidInput', `ATL-RunCheck has no parameter ${k}`);
        if (!re.test(v)) throw new PortError('InvalidInput', `ATL-RunCheck parameter ${k} does not match its allowedPattern`);
      }
    }
    const handler = this.documents.get(req.documentName);
    const commandId = `dev-${(++this.seq).toString().padStart(6, '0')}-${Math.random().toString(16).slice(2, 10)}`;
    for (const instanceId of req.instanceIds) {
      const inv: CommandInvocation = { commandId, instanceId, status: 'InProgress', responseCode: null, stdout: '', stderr: '' };
      this.invocations.set(`${commandId}/${instanceId}`, inv);
      const run = handler
        ? handler(req, instanceId)
        : Promise.resolve({ status: 'Failed' as const, responseCode: 1, stdout: '', stderr: `dev: document ${req.documentName} is not simulated` });
      void run
        .catch((e: unknown) => ({ status: 'Failed' as const, responseCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }))
        .then((r) => Object.assign(inv, r));
    }
    return { commandId };
  }

  async getInvocation(commandId: string, instanceId: string): Promise<CommandInvocation> {
    const inv = this.invocations.get(`${commandId}/${instanceId}`);
    if (!inv) throw new PortError('NotFound', `InvocationDoesNotExist: ${commandId}/${instanceId}`);
    return { ...inv };
  }

  private async runCheck(req: SendCommandRequest, instanceId: string) {
    const runner = this.o.checkRunner;
    if (!runner || !fs.existsSync(runner)) {
      return {
        status: 'Failed' as const,
        responseCode: 127,
        stdout: '',
        stderr: 'dev: check runner not available (set ATL_DEV_CHECK_RUNNER to the runner.mjs of the check bundle)',
      };
    }
    const env = this.o.envs.byInstance(instanceId);
    const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ATL_DEV_MODE: '1', ATL_DEV_INSTANCE_ID: instanceId };
    if (env?.baseUrl) childEnv.ATL_DEV_APP_BASE_URL = env.baseUrl;
    if (env?.root) childEnv.ATL_DEV_APP_ROOT = env.root;
    for (const [k, v] of Object.entries(req.parameters)) childEnv[`SSM_${k}`] = v;
    const timeoutMs = Number(req.parameters.TimeoutSec ?? '20') * 1000 + 5000;
    return new Promise<{ status: 'Success' | 'Failed' | 'TimedOut'; responseCode: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [runner], { cwd: this.o.repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        // Run Command keeps at most 24000 characters of output in the API response (07 V2-5 measures it on AWS)
        resolve({
          status: signal ? 'TimedOut' : code === 0 ? 'Success' : 'Failed',
          responseCode: code,
          stdout: stdout.slice(0, 24000),
          stderr: stderr.slice(0, 8000),
        });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ status: 'Failed', responseCode: 1, stdout, stderr: e.message });
      });
    });
  }
}
