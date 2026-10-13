/**
 * SSM documents (01 §3.6, 03 §3.3–§3.4, §4.6, 04 §6.1): ENV_VAR parameters with tight patterns, no {{ }} in command text,
 * fixed entry points, the Session documents' RunAs and recording settings, and the inline PrepareInstance script.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN_CHECK_PARAMETER_PATTERNS, RUN_CHECK_PARAMETERS, SSM_DOCUMENTS, TERMINAL_RECORDING_LOG_GROUP, WORKSTATION_SETUP_PARAMETERS } from '@atl/shared';
import { describe, expect, it } from 'vitest';
import { loadSsmContent } from '../build/merge-template.js';
import { byType, prop } from './support/template.js';

interface CommandDoc {
  schemaVersion: string;
  parameters: Record<string, { type: string; interpolationType?: string; allowedPattern?: string; default?: string }>;
  mainSteps: { action: string; inputs: { runCommand: string[]; timeoutSeconds: string } }[];
}
interface SessionDoc {
  schemaVersion: string;
  sessionType: string;
  inputs: Record<string, unknown> & { shellProfile: { linux: string } };
}

const doc = <T>(name: string) => loadSsmContent(name) as T;
const commandText = (d: CommandDoc) => d.mainSteps.flatMap((s) => s.inputs.runCommand).join('\n');

describe('ATL-RunCheck (04 §6.1)', () => {
  const d = doc<CommandDoc>('ATL-RunCheck');
  it('has exactly the six parameters, all ENV_VAR, patterns = RUN_CHECK_PARAMETER_PATTERNS', () => {
    expect(Object.keys(d.parameters)).toEqual([...RUN_CHECK_PARAMETERS]);
    for (const name of RUN_CHECK_PARAMETERS) {
      expect(d.parameters[name]!.interpolationType, name).toBe('ENV_VAR');
      expect(d.parameters[name]!.allowedPattern, name).toBe(RUN_CHECK_PARAMETER_PATTERNS[name].source);
    }
  });
  it('only runs the fixed entry point, never interpolates {{ }}', () => {
    expect(d.schemaVersion).toBe('2.2');
    expect(commandText(d)).toBe('exec /opt/atl/bin/atl-check');
    expect(JSON.stringify(d.mainSteps)).not.toContain('{{');
  });
  it('patterns reject shell metacharacters and raw JSON', () => {
    const re = (n: (typeof RUN_CHECK_PARAMETERS)[number]) => new RegExp(d.parameters[n]!.allowedPattern!);
    expect(re('CheckId').test('base.ready')).toBe(true);
    expect(re('CheckId').test('http-probe')).toBe(true);
    expect(re('CheckId').test('x; rm -rf /')).toBe(false);
    expect(re('ArgsB64').test('eyJhIjoxfQ')).toBe(true);
    expect(re('ArgsB64').test('{"a":1}')).toBe(false);
    expect(re('SessionId').test('s4k7m2q9x1abc')).toBe(true);
    expect(re('TimeoutSec').test('81')).toBe(false);
  });
});

describe('ATL-WorkstationSetup (03 §4.6)', () => {
  const d = doc<CommandDoc>('ATL-WorkstationSetup');
  it('four ENV_VAR parameters with patterns; fixed entry point', () => {
    expect(Object.keys(d.parameters)).toEqual([...WORKSTATION_SETUP_PARAMETERS]);
    for (const p of Object.values(d.parameters)) {
      expect(p.interpolationType).toBe('ENV_VAR');
      expect(p.allowedPattern).toMatch(/^\^.*\$$/);
    }
    expect(commandText(d)).toBe('exec /opt/atl/bin/atl-workstation-setup.sh');
    const re = (n: string) => new RegExp(d.parameters[n]!.allowedPattern!);
    expect(re('AgentApiEndpoint').test('https://a1b2c3d4e5.execute-api.ap-northeast-1.amazonaws.com')).toBe(true);
    expect(re('AgentApiEndpoint').test('https://evil.example.com')).toBe(false);
    expect(re('PlatformOrigin').test('https://d1234abcd.cloudfront.net')).toBe(true);
    expect(re('PlatformOrigin').test('https://x.example.com/$(id)')).toBe(false);
  });
});

describe('Session documents (03 §3.3)', () => {
  it('ATL-SessionShell: RunAs labuser, no recording, no KMS, shell profile through term-entry.sh', () => {
    const d = doc<SessionDoc>('ATL-SessionShell');
    expect(d.sessionType).toBe('Standard_Stream');
    expect(d.inputs).toMatchObject({ runAsEnabled: true, runAsDefaultUser: 'labuser', cloudWatchLogGroupName: '', kmsKeyId: '', idleSessionTimeout: '20', maxSessionDuration: '240' });
    expect(d.inputs.shellProfile.linux).toContain('/opt/atl/terminal/term-entry.sh');
  });
  it('ATL-SessionShell-Logged: same plus streaming to the recording log group', () => {
    const plain = doc<SessionDoc>('ATL-SessionShell');
    const logged = doc<SessionDoc>('ATL-SessionShell-Logged');
    expect(logged.inputs).toMatchObject({ cloudWatchLogGroupName: TERMINAL_RECORDING_LOG_GROUP, cloudWatchStreamingEnabled: true, cloudWatchEncryptionEnabled: false });
    const strip = (i: Record<string, unknown>) => {
      const { cloudWatchLogGroupName: _a, cloudWatchStreamingEnabled: _b, ...rest } = i;
      return rest;
    };
    expect(strip(logged.inputs)).toEqual(strip(plain.inputs));
  });
});

describe('ATL-PrepareInstance (03 §3.4)', () => {
  const d = doc<CommandDoc>('ATL-PrepareInstance');
  const script = commandText(d);
  it('creates labuser 2100 with sudo, the terminal helpers, prepared.json', () => {
    expect(script).toContain('useradd -u 2100 -g 2100');
    expect(script).toContain('/etc/sudoers.d/90-atl-labuser');
    expect(script).toContain('/opt/atl/terminal/term-entry.sh');
    expect(script).toContain('/opt/atl/terminal/shell-integration.bash');
    expect(script).toContain('/var/lib/atl/prepared.json');
    expect(script).not.toMatch(/\/opt\/atl\/checks|atl-check/);
    expect(d.parameters.TermPersist).toMatchObject({ interpolationType: 'ENV_VAR', allowedPattern: '^(none|tmux)$' });
  });
  const bash = spawnSync('bash', ['--version']).status === 0;
  it.skipIf(!bash)('is valid bash', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atl-ssm-')), 'prepare.sh');
    fs.writeFileSync(f, script.replace(/\r\n/g, '\n'));
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('template embedding', () => {
  it('every document is embedded as JSON content with UpdateMethod NewVersion', () => {
    const docs = byType('AWS::SSM::Document');
    expect(docs.map(([, r]) => prop(r, 'Name')).sort()).toEqual([...SSM_DOCUMENTS].sort());
    for (const [, r] of docs) {
      expect(prop(r, 'DocumentFormat')).toBe('JSON');
      expect(prop(r, 'UpdateMethod')).toBe('NewVersion');
      expect(prop(r, 'Content')).toEqual(loadSsmContent(prop<string>(r, 'Name')));
      expect(JSON.stringify(prop(r, 'Tags'))).not.toContain('atl:component');
    }
  });
});
