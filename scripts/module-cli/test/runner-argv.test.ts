// The ATL runner (platform/workflows/src/runner) calls scripts/module with fixed argument vectors (02 §8, 06 PM-35).
// Every vector must parse: no unknown option, no missing argument. Actions are replaced, so nothing runs.
import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/index.js';

const RUNNER_TAIL = ['--platform', '--progress-jsonl', 'progress.jsonl', '--result-json', 'result.json', '--lock-wait', '900'];

const VECTORS: string[][] = [
  ['bootstrap', '--env', 'dev', '--release-file', 'cloudalbum-1.0.0-arm64.tgz'],
  ['base', 'deploy', '--env', 'dev', '--delivery', 'ssm', '--instance-profile', 'CloudAlbumAppRole', '--key-name', 'atl-dev',
    '--disable-rollback', '--retry-az'],
  ['env', 'resume'],
  ['env', 'suspend'],
  ['env', 'destroy', '--fast', '--ledger-out', 'ledger.json'],
  ['plan', '--profile', 'atl/svc-cdn/default', '--json'],
  ['profile', 'apply', 'atl/svc-cdn/default', '--mode', 'fresh', '--repair', '--yes'],
  ['status', '--repair'],
  ['status', '--json'],
  ['seed', 'cognito-test-users'],
  ['hooks', 'run', '--pending'],
  ['enable', 'cdn', '--param', 'PriceClass=PriceClass_100'],
  ['disable', 'cdn', '--param', 'reason=card'],
  ['iam', 'revoke-older-sessions', '--param', 'note=x'],
  ['iam', 'refresh-instance-credentials'],
];

const GROUPS = new Set(['base', 'env', 'profile', 'hooks', 'iam']);

function leaves(cmd: Command): Command[] {
  return cmd.commands.length ? cmd.commands.flatMap(leaves) : [cmd];
}

function parse(argv: string[]): { name: string; globals: Record<string, unknown> } {
  const program = buildProgram();
  let hit = '';
  const all = [program, ...program.commands, ...program.commands.flatMap((c) => c.commands)];
  for (const c of all) {
    c.exitOverride();
    c.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  }
  for (const leaf of leaves(program)) leaf.action(() => { hit = leaf.name(); });
  program.parse(argv, { from: 'user' });
  return { name: hit, globals: program.opts() };
}

describe('runner argument vectors', () => {
  it.each(VECTORS.map((v) => [v.join(' '), v]))('parses %s', (_label, argv) => {
    const r = parse([...(argv as string[]), ...RUNNER_TAIL]);
    const [first, second] = argv as string[];
    expect(r.name).toBe(GROUPS.has(first!) ? second : first);
    expect(r.globals.platform).toBe(true);
    expect(r.globals.lockWait).toBe('900');
  });

  it('--delivery accepts only ssh | ssm', () => {
    expect(parse(['base', 'deploy', '--delivery', 'ssm']).globals.delivery).toBe('ssm');
    expect(() => parse(['base', 'deploy', '--delivery', 'scp'])).toThrow(CommanderError);
  });
});
