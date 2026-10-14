import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RemoteScript, SsmDeliverer } from '../src/deliver.js';
import { DryRunGateway } from '../src/aws.js';
import { CapturePrinter, CliError } from '../src/printer.js';
import { enableCommand } from '../src/enable.js';
import { disableCommand } from '../src/disable.js';
import { profileDiff } from '../src/profile-cmd.js';
import { createZip } from '../src/package.js';
import { generateSingleProfile, parseProfile, resolveProfile, loadProfileFile } from '../src/profiles.js';
import { internalEndpointsBlock, topologicalModules } from '../src/meta.js';
import { IMPLEMENTED_MODULES, SECRET_NAMES, isSecretLikeKey, secretEnvName } from '../src/registry.js';
import { formatEnvValue, parseAssignments, parseEnvFile, renderEnvFile } from '../src/env-file.js';
import { SECRET_NAMES as BACKEND_SECRET_NAMES, secretEnvName as backendSecretEnvName } from '../../../backend/src/ports/secrets.js';
import { isSecretLikeKey as backendIsSecretLike } from '../../../backend/src/config/load-env.js';
import { REPO_ROOT, deployedState, dryContext } from './helpers.js';

describe('scripts/module enable --dry-run (no AWS call is executed)', () => {
  it('enable storage without iam stops with CRED-001 (exit 2)', async () => {
    const { ctx, out, aws, deliverer } = dryContext();
    expect(await enableCommand(ctx, 'storage', {})).toBe(2);
    expect(out.text()).toContain('CRED-001');
    expect(aws.calls.filter((c) => c.op !== 'DescribeStacks')).toEqual([]);
    expect(deliverer.scripts).toEqual([]);
  });

  it('enable storage --with-deps: iam stack, base stack InstanceProfileName, storage stack, deliveries', async () => {
    const { ctx, out, aws, deliverer } = dryContext();
    expect(await enableCommand(ctx, 'storage', { withDeps: true, migrate: false })).toBe(0);
    const deployed = aws.calls.filter((c) => c.service === 'cloudformation' && /Stack$/.test(c.op)).map((c) => c.input.StackName);
    expect(deployed).toEqual(['cloudalbum-lab-iam', 'cloudalbum-lab-ec2', 'cloudalbum-lab-storage']);
    const base = aws.calls.find((c) => c.input.StackName === 'cloudalbum-lab-ec2' && /Stack$/.test(c.op))!;
    expect(base.input.Parameters).toEqual([{ ParameterKey: 'InstanceProfileName', ParameterValue: 'CloudAlbumAppRole' }]);
    const storage = aws.calls.find((c) => c.input.StackName === 'cloudalbum-lab-storage' && /Stack$/.test(c.op))!;
    expect(storage.input.Parameters).toContainEqual({ ParameterKey: 'AppOrigins', ParameterValue: 'http://203.0.113.10' });
    expect(storage.input.Tags).toContainEqual({ Key: 'ManagedBy', Value: 'scripts/module' });
    // PolicyArn of storage attached to CloudAlbumAppRole (printed)
    expect(aws.calls.some((c) => c.op === 'AttachRolePolicy' && c.input.RoleName === 'CloudAlbumAppRole')).toBe(true);
    const enableScript = deliverer.scripts.find((s) => s.title === 'enable storage')!.render();
    expect(enableScript).toContain('MODULE_STORAGE=on');
    expect(enableScript).toContain('STORAGE_DRIVER=s3');
    expect(enableScript).toContain('check-config');
    expect(out.text()).toContain('[11] done');
    expect(existsSync(ctx.stateFile)).toBe(false);   // dry-run never writes state.json
  });

  it('enable cdn: origin-verify generated, NoEcho parameter and secrets.env value redacted, baseParams applied', async () => {
    const { ctx, out, aws, deliverer } = dryContext();
    expect(await enableCommand(ctx, 'cdn', { set: ['CDN_DIRECT_ACCESS=admin-ip', 'CDN_ADMIN_CIDR=198.51.100.7/32'] })).toBe(0);
    const stack = aws.calls.find((c) => c.input.StackName === 'cloudalbum-lab-cdn' && /Stack$/.test(c.op))!;
    const params = stack.input.Parameters as Array<{ ParameterKey: string; ParameterValue?: string }>;
    const secret = params.find((p) => p.ParameterKey === 'OriginVerifySecret')!.ParameterValue!;
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(params.find((p) => p.ParameterKey === 'OriginDomainName')!.ParameterValue).toBe('ec2-203-0-113-10.ap-northeast-1.compute.amazonaws.com');
    expect(params.find((p) => p.ParameterKey === 'VpcId')!.ParameterValue).toBe('vpc-0aaa');
    expect(JSON.stringify(stack.display)).not.toContain(secret);
    expect(out.text()).not.toContain(secret);
    const script = deliverer.scripts.find((s) => s.title === 'enable cdn')!;
    expect(script.render()).toContain(`ORIGIN_VERIFY=${secret}`);
    expect(script.display()).not.toContain(secret);
    expect(script.render()).toContain('run-hostsetup.sh cdn apply');
    expect(script.render()).toContain('systemctl restart nginx');
    const base = aws.calls.find((c) => c.input.StackName === 'cloudalbum-lab-ec2' && /Stack$/.test(c.op))!;
    expect(base.input.Parameters).toEqual(expect.arrayContaining([
      { ParameterKey: 'PublicHttpIngress', ParameterValue: 'admin-ip' },
      { ParameterKey: 'AdminIngressCidr', ParameterValue: '198.51.100.7/32' },
    ]));
    expect(script.render()).toContain('CDN_DIRECT_ACCESS=admin-ip');
  });

  it('local tier (cache --driver memory): no stack, no MODULE flag', async () => {
    const { ctx, aws, deliverer } = dryContext();
    expect(await enableCommand(ctx, 'cache', { driver: 'memory' })).toBe(0);
    expect(aws.calls.filter((c) => /Stack$/.test(c.op))).toEqual([]);
    const s = deliverer.scripts.find((x) => x.title === 'enable cache')!.render();
    expect(s).toContain('CACHE_DRIVER=memory');
    expect(s).not.toContain('MODULE_CACHE=on');
  });

  it('modules not implemented in this round are refused', async () => {
    const { ctx } = dryContext();
    await expect(enableCommand(ctx, 'social-store', { withDeps: true })).rejects.toThrow(CliError);
  });

  it('disable refuses while a dependent module is enabled, and cascades on request', async () => {
    const { ctx, out } = dryContext();
    expect(await enableCommand(ctx, 'image-processing', { withDeps: true, migrate: false, param: [] })).toBe(0);
    expect(Object.keys(ctx.state.modules)).toEqual(['iam', 'storage', 'image-processing']);
    expect(await disableCommand(ctx, 'storage', {})).toBe(2);
    expect(out.text()).toContain('image-processing needs STORAGE_DRIVER=s3 (DEP-003)');
    expect(await disableCommand(ctx, 'storage', { cascade: true, abandonData: true })).toBe(0);
    expect(Object.keys(ctx.state.modules)).toEqual(['iam']);
  });
});

describe('profiles (10.1, 10.4)', () => {
  it('committed profiles/single/<id>.env are exactly what gen-single produces', () => {
    for (const id of IMPLEMENTED_MODULES) {
      const file = path.join(REPO_ROOT, 'profiles', 'single', `${id}.env`);
      expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), id).toBe(generateSingleProfile(id));
    }
  });

  it('single/queue adds the worker local tier (10.4 rule 3) and resolves through PROFILE_EXTENDS', () => {
    const r = resolveProfile((n) => loadProfileFile(REPO_ROOT, n), 'single/queue');
    expect(r.chain).toEqual(['l0-ec2', 'single/queue']);
    expect([...r.targets.values()].map((t) => `${t.module}=${t.value}:${t.tier}`).sort())
      .toEqual(['iam=role:aws', 'image-processing=worker:local', 'queue=sqs:aws']);
  });

  it('parses the 10.1 format (drivers, params, optional)', () => {
    const p = parseProfile('PROFILE_NAME=x\nPROFILE_MODULES=iam,database\nPROFILE_DRIVERS=IAM_CREDENTIALS=role,DB_DRIVER=postgres\nPROFILE_PARAMS=database.MultiAz=false\nPROFILE_OPTIONAL=cache\n');
    expect(p).toMatchObject({ name: 'x', modules: ['iam', 'database'], optional: ['cache'], params: { 'database.MultiAz': 'false' } });
    const r = resolveProfile(() => p, 'x', { withOptional: true });
    expect(r.params.database).toEqual({ MultiAz: 'false' });
    expect([...r.targets.keys()]).toEqual(['iam', 'database', 'cache']);
  });

  it('profile diff from a populated state disables what the profile does not want', async () => {
    const state = deployedState();
    const { ctx, out } = dryContext(state);
    await enableCommand(ctx, 'storage', { withDeps: true, migrate: false });
    await profileDiff(ctx, 'single/cdn', {});
    expect(out.text()).toContain('disable (reverse topological): storage, iam');
    expect(out.text()).toMatch(/enable {2}\(topological\): +cdn=aws/);
  });
});

describe('release metadata, nginx internal endpoints, secrets parity, zip, delivery', () => {
  it('cloudalbum_locations.conf internal endpoints block is generated from the registry', () => {
    const b = internalEndpointsBlock(REPO_ROOT);
    expect(b.current).toBe(b.expected);
    expect(b.expected).toContain('location = /internal/hooks/image-processed');
  });

  it('topological order starts with ec2 and puts iam before credential-requiring modules', () => {
    const order = topologicalModules();
    expect(order[0]).toBe('ec2');
    expect(order.indexOf('iam')).toBeLessThan(order.indexOf('storage'));
    expect(order.indexOf('storage')).toBeLessThan(order.indexOf('image-processing'));
    expect(order.indexOf('kms')).toBeLessThan(order.indexOf('database'));
  });

  it('secret names and the secret-like key rule mirror the backend', () => {
    expect([...SECRET_NAMES]).toEqual([...BACKEND_SECRET_NAMES]);
    for (const n of SECRET_NAMES) expect(secretEnvName(n)).toBe(backendSecretEnvName(n));
    for (const k of ['DB_PASSWORD', 'DB_PASSWORD_SECRET_ARN', 'ORIGIN_VERIFY', 'REDIS_AUTH_TOKEN', 'IAM_KEYS_ACCESS_KEY_ID', 'CDN_BASE_URL', 'COGNITO_CLIENT_SECRET', 'JWT_SIGNING_KEY_FILE', 'X_PRIVATE_KEY']) {
      expect(isSecretLikeKey(k), k).toBe(backendIsSecretLike(k));
    }
  });

  it('zip writer produces entries that inflate back to the input', () => {
    const data = Buffer.from('export const handler = async () => 1;\n'.repeat(50));
    const zip = createZip([{ name: 'index.mjs', data }, { name: 'node_modules/x/a.txt', data: Buffer.from('a') }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    const size = zip.readUInt32LE(18);
    expect(zip.subarray(30, 30 + nameLen).toString()).toBe('index.mjs');
    expect(inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size)).equals(data)).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(2);
  });

  it('remote scripts redact secrets; SSM refuses secret-bearing scripts', async () => {
    const s = new RemoteScript('t');
    s.upsertSecrets({ ORIGIN_VERIFY: 'very-secret-value' });
    s.writeFile('/etc/cloudalbum/modules.d/cdn.env', 'MODULE_CDN=on\n', { mode: '0640', owner: 'root:cloudalbum', backup: true });
    expect(s.render()).toContain('very-secret-value');
    expect(s.display()).not.toContain('very-secret-value');
    expect(s.render()).toMatch(/cat > "\$ca_tmp" <<'CA_EOF_[0-9a-f]+'/);
    const ssm = new SsmDeliverer(new DryRunGateway(new CapturePrinter()), 'i-1', new CapturePrinter());
    await expect(ssm.run(s)).rejects.toThrow(/SSM Run Command keeps command parameters/);
  });

  it('standalone over SSM (shell-access enabled): the secrets.env upsert goes through a SecureString hand-off; read-back is refused with a way out', async () => {
    const gw = new DryRunGateway(new CapturePrinter());
    const ssm = new SsmDeliverer(gw, 'i-1', new CapturePrinter(), undefined, { prefix: '/cloudalbum/lab/handoff/abcd1234', region: 'ap-northeast-1' });
    const s = new RemoteScript('t').upsertSecrets({ ORIGIN_VERIFY: 'very-secret-value' });
    expect((await ssm.run(s)).code).toBe(0);
    const put = gw.calls.find((c) => c.op === 'PutParameter')!;
    expect(put.input).toMatchObject({ Name: '/cloudalbum/lab/handoff/abcd1234-1', Type: 'SecureString' });
    const send = gw.calls.find((c) => c.op === 'SendCommand')!;
    expect(JSON.stringify(send.input)).not.toContain('very-secret-value');
    expect(JSON.stringify(send.input)).toContain('aws ssm get-parameter --region ap-northeast-1 --name /cloudalbum/lab/handoff/abcd1234-1');
    expect(gw.calls.find((c) => c.op === 'DeleteParameter')?.input.Name).toBe('/cloudalbum/lab/handoff/abcd1234-1');
    // any other secret (e.g. the read-back marker) is still refused
    const inline = new RemoteScript('read');
    inline.secret('__marker__');
    await expect(ssm.run(inline)).rejects.toThrow(/carries secret values/);

    const state = deployedState();
    state.modules['shell-access'] = { tier: 'aws', value: 'ssm', version: 1, enabledAt: 'x', updatedAt: 'x', secretKeys: [], params: {}, outputs: {}, env: {}, stacks: [] } as never;
    const { createContext } = await import('../src/context.js');
    const { readRemoteSecrets } = await import('../src/hooks.js');
    const out = new CapturePrinter();
    const ctx = createContext({ dryRun: true, yes: true, skipLocalCheck: true, state: path.join(REPO_ROOT, '.cloudalbum', 'never-written.json') },
      { aws: new DryRunGateway(out), out, repoRoot: REPO_ROOT, state });
    expect(ctx.deliverer().channel).toBe('ssm');
    await expect(readRemoteSecrets(ctx, ['DB_PASSWORD'])).rejects.toMatchObject({ code: 'SECRETS_READBACK_OVER_SSM' });
    await expect(readRemoteSecrets(ctx, ['DB_PASSWORD'])).rejects.toThrow(/--delivery ssh/);
  });

  it('env files round-trip', () => {
    const env = { A: 'x', B: 'has space', C: '', D: 'https://h/p?q=1', E: 'a#b' };
    expect(parseEnvFile(renderEnvFile(env))).toEqual(env);
    expect(formatEnvValue('plain-value_1')).toBe('plain-value_1');
    expect(parseAssignments(['AppOrigins=http://a,https://b,X=1'])).toEqual({ AppOrigins: 'http://a,https://b', X: '1' });
    expect(() => parseAssignments(['nope'])).toThrow(/KEY=VALUE/);
  });
});
