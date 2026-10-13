// backend/src/modules/detectors/iam.ts —— iam 感知器：凭证来源感知（总纲 3.3；02#iam 第 2、10 节）
//
// iam 是应用适配器型模块，capabilities 的主探针在 adapters/iam/{role,keys}.ts 的 probe()；本感知器回答“凭证从哪里来”：
//   - IMDS / 本机：实例上是否挂了实例配置文件、角色名（iam/security-credentials/）、实例配置文件 ARN（iam/info）；
//   - 残留的长期密钥：进程环境变量 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_PROFILE，role 模式下 secrets.env 中仍有 IAM_KEYS_*；
//   - 控制面（需要凭证）：sts:GetCallerIdentity（认证，不受策略约束）+ iam:GetRole / iam:GetUser（授权，受策略约束），
//     访问密钥前缀 ASIA（临时）/ AKIA（长期）与过期时间。
// 导出的辅助函数（classifyCallerArn、residualKeyFindings、checkCallerAndAuthorization）供 role / keys 驱动的探针复用。
import type { STSClient } from '@aws-sdk/client-sts';
import type { AwsClients } from '../../adapters/aws/clients.js';
import { describeAwsError, isAwsAccessDenied, loadAwsPackage } from '../../adapters/aws/clients.js';
import type { ProbeResult } from '../../ports/common.js';
import { ImdsClient } from './ec2.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

export type CallerKind = 'assumed-role' | 'user' | 'root' | 'other';

/** arn:aws:sts::123:assumed-role/CloudAlbumAppRole/i-0abc → { kind: 'assumed-role', name: 'CloudAlbumAppRole', session: 'i-0abc' } */
export function classifyCallerArn(arn: string): { kind: CallerKind; name?: string; session?: string; account?: string } {
  const m = /^arn:aws[a-z-]*:(sts|iam)::(\d{12}):(.+)$/.exec(arn);
  if (!m) return { kind: 'other' };
  const account = m[2]!;
  const resource = m[3]!;
  if (resource === 'root') return { kind: 'root', account };
  const [type, name, session] = resource.split('/');
  if (type === 'assumed-role') return { kind: 'assumed-role', account, ...(name ? { name } : {}), ...(session ? { session } : {}) };
  if (type === 'user') return { kind: 'user', account, name: resource.split('/').pop()! };
  return { kind: 'other', account };
}

export function keyPrefixOf(accessKeyId: string | undefined): 'ASIA' | 'AKIA' | undefined {
  if (!accessKeyId) return undefined;
  if (accessKeyId.startsWith('ASIA')) return 'ASIA';
  if (accessKeyId.startsWith('AKIA')) return 'AKIA';
  return undefined;
}

/**
 * 残留的长期密钥（02#iam 常见坑：SDK 默认凭证链会优先使用环境变量）。
 * processEnv 是进程环境（不是分层配置）；layered 是分层加载的合并结果（含 secrets.env）。
 */
export function residualKeyFindings(mode: 'none' | 'role' | 'keys', processEnv: NodeJS.ProcessEnv, layered: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  if (processEnv.AWS_ACCESS_KEY_ID || processEnv.AWS_SECRET_ACCESS_KEY) out.push('进程环境变量中有 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
  if (processEnv.AWS_PROFILE) out.push(`进程环境变量中有 AWS_PROFILE=${processEnv.AWS_PROFILE}`);
  if (mode === 'role' && (layered.IAM_KEYS_ACCESS_KEY_ID || layered.IAM_KEYS_SECRET_ACCESS_KEY)) out.push('secrets.env 中仍有 IAM_KEYS_*（切回 role 后应删除）');
  return out;
}

export interface CallerCheck {
  arn?: string;
  account?: string;
  kind?: CallerKind;
  principalName?: string;
  keyPrefix?: 'ASIA' | 'AKIA';
  expiresAt?: string;
  authenticated: boolean;
  authorized?: boolean;
  authError?: string;
  authzError?: string;
}

/** ① sts:GetCallerIdentity（认证）② iam:GetRole（role）/ iam:GetUser（keys）（授权）；两列分别报告 */
export async function checkCallerAndAuthorization(aws: AwsClients): Promise<CallerCheck> {
  const { GetCallerIdentityCommand } = await loadAwsPackage('@aws-sdk/client-sts', () => import('@aws-sdk/client-sts'));
  let sts: STSClient;
  const out: CallerCheck = { authenticated: false };
  try {
    sts = await aws.sts();
    const creds = await (sts.config.credentials as () => Promise<{ accessKeyId: string; expiration?: Date }>)();
    const prefix = keyPrefixOf(creds.accessKeyId);
    if (prefix) out.keyPrefix = prefix;
    if (creds.expiration) out.expiresAt = new Date(creds.expiration).toISOString();
    const id = await sts.send(new GetCallerIdentityCommand({}));
    if (id.Arn) {
      out.arn = id.Arn;
      const c = classifyCallerArn(id.Arn);
      out.kind = c.kind;
      if (c.name) out.principalName = c.name;
    }
    if (id.Account) out.account = id.Account;
    out.authenticated = true;
  } catch (e) {
    out.authError = describeAwsError(e);
    return out;
  }
  if (!out.principalName || (out.kind !== 'assumed-role' && out.kind !== 'user')) return out;
  try {
    const iamSdk = await loadAwsPackage('@aws-sdk/client-iam', () => import('@aws-sdk/client-iam'));
    const iam = await aws.iam();
    if (out.kind === 'assumed-role') await iam.send(new iamSdk.GetRoleCommand({ RoleName: out.principalName }));
    else await iam.send(new iamSdk.GetUserCommand({ UserName: out.principalName }));
    out.authorized = true;
  } catch (e) {
    out.authorized = false;
    out.authzError = isAwsAccessDenied(e) ? `AccessDenied：${(e as Error).message}` : describeAwsError(e);
  }
  return out;
}

export interface IamDetectorOptions {
  imds?: ImdsClient;
  processEnv?: NodeJS.ProcessEnv;
}

export class IamDetector implements Detector {
  readonly module = 'iam' as const;
  private readonly imds: ImdsClient;
  private readonly processEnv: NodeJS.ProcessEnv;
  private last: { residual: string[]; imdsRole?: string | null; keyPrefix?: string; authorized?: boolean } = { residual: [] };

  constructor(protected readonly ctx: DetectorContext, opts: IamDetectorOptions = {}) {
    this.imds = opts.imds ?? new ImdsClient({ timeoutMs: ctx.cfg.iam.IAM_IMDS_TIMEOUT_MS });
    this.processEnv = opts.processEnv ?? process.env;
  }

  /** IMDS 中的实例配置文件：角色名与 ARN；不在 EC2 上返回 null */
  async imdsRole(): Promise<{ roleName: string | null; instanceProfileArn?: string } | null> {
    if (!(await this.imds.token())) return null;
    const list = await this.imds.get('/latest/meta-data/iam/security-credentials/');
    const roleName = list && list.status === 200 ? list.body.trim().split('\n')[0]?.trim() || null : null;
    let instanceProfileArn: string | undefined;
    const info = await this.imds.get('/latest/meta-data/iam/info');
    if (info && info.status === 200) {
      try {
        instanceProfileArn = (JSON.parse(info.body) as { InstanceProfileArn?: string }).InstanceProfileArn;
      } catch {
        /* 忽略 */
      }
    }
    return { roleName, ...(instanceProfileArn ? { instanceProfileArn } : {}) };
  }

  async detect(_opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const mode = this.ctx.cfg.iam.IAM_CREDENTIALS;
    const expectedRole = this.ctx.cfg.iam.IAM_EXPECTED_ROLE;
    const residual = residualKeyFindings(mode, this.processEnv, this.ctx.env);
    const imds = await this.imdsRole();
    const data: Record<string, unknown> = { mode, expectedRole, residualKeys: residual };
    if (imds) Object.assign(data, { imdsRole: imds.roleName, ...(imds.instanceProfileArn ? { instanceProfileArn: imds.instanceProfileArn } : {}) });
    this.last = { residual, ...(imds ? { imdsRole: imds.roleName } : {}) };

    if (mode === 'none') {
      return {
        status: 'ok',
        detail: `应用未使用 AWS 凭证${imds?.roleName ? `（实例上挂着角色 ${imds.roleName}，但 IAM_CREDENTIALS=none）` : ''}`,
        confidence: imds ? 'observed' : 'inferred',
        data,
      };
    }
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    if (mode === 'role') {
      if (imds === null) problems.push('IMDS 不可达（不在 EC2 上，或 HttpEndpoint=disabled）');
      else if (!imds.roleName) {
        status = 'error';
        problems.push('IMDS 中没有角色：实例未挂实例配置文件');
      }
    }
    if (!this.ctx.aws.enabled) {
      return { status: 'error', detail: `IAM_CREDENTIALS=${mode}，但没有可用的凭证 provider`, confidence: 'inferred', data };
    }
    const caller = await checkCallerAndAuthorization(this.ctx.aws);
    Object.assign(data, { caller });
    this.last.keyPrefix = caller.keyPrefix;
    if (caller.authorized !== undefined) this.last.authorized = caller.authorized;
    if (!caller.authenticated) {
      return { status: 'error', detail: `GetCallerIdentity 失败：${caller.authError}`, confidence: 'confirmed', data };
    }
    if (mode === 'role') {
      if (caller.kind !== 'assumed-role' || caller.principalName !== expectedRole) {
        status = 'error';
        problems.push(`调用者 ${caller.arn} 不是预期角色 ${expectedRole}`);
      }
      if (caller.keyPrefix === 'AKIA') {
        status = 'error';
        problems.push('role 模式下用的却是长期密钥（AKIA）');
      }
    } else {
      status = 'degraded';                                    // keys 始终至少 degraded（CRED-002）
      problems.push('长期访问密钥（AKIA）落盘在 secrets.env（CRED-002）');
    }
    if (caller.authorized === false) {
      status = 'error';
      problems.push(`授权检查失败（${mode === 'role' ? 'iam:GetRole' : 'iam:GetUser'}）：${caller.authzError}`);
    }
    if (residual.length) {
      if (status === 'ok') status = 'degraded';
      problems.push(`检测到残留的长期密钥：${residual.join('；')}`);
    }
    const expiry = caller.expiresAt ? `，约 ${Math.max(0, Math.round((Date.parse(caller.expiresAt) - Date.now()) / 60_000))} 分钟后轮换` : mode === 'keys' ? '，永不过期（需人工轮换）' : '';
    const who = caller.kind === 'assumed-role' ? `assumed-role/${caller.principalName}` : caller.arn ?? '?';
    const detail = `${who}（${caller.keyPrefix ?? '?'}…${expiry}）${caller.authorized ? ' · 授权检查通过' : ''}${problems.length ? ` · ${problems.join('；')}` : ''}`;
    return { status, detail, confidence: 'confirmed', data };
  }

  /** 运行期观测（/lab 与规则引擎）：残留密钥、IMDS 角色、密钥前缀 */
  observations(): Record<string, unknown> {
    return {
      residualLongTermKeys: this.last.residual.length > 0,
      ...(this.last.imdsRole !== undefined ? { imdsRole: this.last.imdsRole } : {}),
      ...(this.last.keyPrefix ? { keyPrefix: this.last.keyPrefix } : {}),
      ...(this.last.authorized !== undefined ? { authorized: this.last.authorized } : {}),
    };
  }
}

export const iamDetector: DetectorFactory = { module: 'iam', create: (ctx) => new IamDetector(ctx) };
