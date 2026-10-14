// backend/src/adapters/waf/aws.ts —— BlocklistPort 的 `aws` 驱动（AWS WAF；01#waf 第 2、3、10 节；wave1-waf）
//
// denylist.conf 仍是实例上的唯一来源（统一值 C19）：add / remove 先经 nginx 驱动写 security/denylist.conf（path 单元校验后
// reload，Nginx 秒级生效，保护直连入口），再把“当前未过期的 IPv4 条目”整体同步到 WAF IP 集合 cloudalbum-blocklist：
//   wafv2:GetIPSet 取 LockToken → UpdateIPSet（乐观锁；WAFOptimisticLockException 时重读重试）。CLOUDFRONT 范围的 IP 集合在
//   us-east-1（区域取 WAF_WEB_ACL_ARN 中的区域），SDK 客户端由 adapters/aws/clients.ts 创建。
// - 非权威端口：同步失败不影响本地封禁，只让 waf 变为 degraded（最近一次同步结果写在 security/waf-sync.json，api 与 worker 共读）。
// - worker 进程每分钟比对一次（init() 在 role=worker 时启动循环；多实例时经 LockPort 只在一台上执行），把 fail2ban 新增或到期的条目
//   增量带到 IP 集合；首次启用时 scripts/module 的 waf hook（afterDeploy）做一次全量导入（scripts/waf/sync-denylist 的职责）。
// - 无凭证（IAM_CREDENTIALS=none）：只写本地 denylist，返回 effective=after-reload 并说明“未同步到 AWS WAF”，状态 degraded。
// - IPv6 条目只在本地生效（IP 集合是 IPV4），探针 detail 中计数。
// - 探针：WafDetector 的 detect()（被动比例 + 控制面）+ nginx 驱动的 denylist 状态 + 同步状态；container 若调用 attachDetector()
//   传入登记表中的感知器实例，被动比例才有数据（否则只有控制面部分）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { BlocklistPort } from '../../ports/blocklist.js';
import { startLoop, type LoopHandle } from '../../modules/probe-loop.js';
import { WafDetector } from '../../modules/detectors/waf.js';
import type { Detector } from '../../modules/detectors/types.js';
import { awsErrorName, describeAwsError, loadAwsPackage, withAwsRetry } from '../aws/clients.js';
import { desiredAddresses, diffAddresses, parseWebAclArn } from './ipset.js';
import { NginxBlocklist } from './nginx.js';

/** block / unblock 的结果（端口的 add / remove 声明为 void；管理后台据此显示“正在传播 / reload 后生效”） */
export interface BlockEffect {
  effective: 'after-reload' | 'propagating';
  synced: boolean;
  detail: string;
}

export interface SyncResult {
  added: number;
  removed: number;
  total: number;
  skippedIpv6: number;
  unchanged: boolean;
}

export interface SyncState {
  at: string;
  ok: boolean;
  role: string;
  result?: SyncResult;
  error?: string;
}

export const SYNC_LOCK = 'waf-ipset-sync';
const MAX_LOCK_RETRIES = 4;

export interface AwsBlocklistOptions {
  now?: () => number;
  /** worker 同步循环的间隔（秒，默认 60） */
  syncIntervalSec?: number;
}

export class AwsBlocklist implements BlocklistPort {
  readonly meta: AdapterMeta = { module: 'waf', driver: 'aws', awsService: 'AWS WAF', authoritative: false };
  private readonly local: NginxBlocklist;
  private detector: WafDetector;
  private readonly now: () => number;
  private loop?: LoopHandle;
  private syncing?: Promise<SyncResult>;
  private lastSync?: SyncState;

  constructor(protected readonly deps: AdapterDeps, private readonly opts: AwsBlocklistOptions = {}) {
    this.local = new NginxBlocklist(deps);
    this.now = opts.now ?? (() => Date.now());
    this.detector = new WafDetector({ cfg: deps.cfg, env: deps.env, aws: deps.aws }, { now: this.now });
  }

  /** container：传入登记表中的 waf 感知器（它收到每个请求的 observe()），探针才有被动比例 */
  attachDetector(det: Detector): void {
    if (det instanceof WafDetector) this.detector = det;
  }

  get syncStateFile(): string {
    return path.join(this.deps.cfg.core.CLOUDALBUM_DATA_DIR, 'security', 'waf-sync.json');
  }

  private get scope(): 'CLOUDFRONT' | 'REGIONAL' {
    return parseWebAclArn(this.deps.cfg.waf.WAF_WEB_ACL_ARN)?.scope ?? (this.deps.cfg.waf.WAF_SCOPE === 'REGIONAL' ? 'REGIONAL' : 'CLOUDFRONT');
  }

  async init(): Promise<void> {
    if (this.deps.role === 'worker' && this.deps.aws.enabled) this.startSyncLoop();
  }

  /** worker：每分钟把 denylist 与 IP 集合比对一次（多实例时经 LockPort 只在一台上执行） */
  startSyncLoop(intervalSec = this.opts.syncIntervalSec ?? 60): LoopHandle {
    this.loop?.stop();
    this.loop = startLoop(async () => {
      const lease = this.deps.lock ? await this.deps.lock.tryAcquire(SYNC_LOCK, Math.max(10, intervalSec - 5)) : null;
      if (this.deps.lock && !lease) return;
      try {
        await this.sync();
      } finally {
        await lease?.release().catch(() => undefined);
      }
    }, {
      intervalSec, jitterSec: 5, immediate: true,
      onError: (e) => this.deps.logger?.warn('waf: IP 集合同步失败', { error: describeAwsError(e) }),
    });
    return this.loop;
  }

  async close(): Promise<void> {
    this.loop?.stop();
    this.loop = undefined;
  }

  async list(): Promise<Array<{ cidr: string; reason: string; addedAt: string; source: 'app' | 'fail2ban' | 'manual' }>> {
    return this.local.list();
  }

  async add(cidr: string, reason: string, ttlSec?: number): Promise<void> {
    await this.block(cidr, reason, ttlSec);
  }

  async remove(cidr: string): Promise<void> {
    await this.unblock(cidr);
  }

  /** add() 的完整结果：本地 denylist 立即写入，再同步到 IP 集合（管理后台据此显示“正在传播到 AWS WAF”） */
  async block(cidr: string, reason: string, ttlSec?: number): Promise<BlockEffect> {
    await this.local.add(cidr, reason, ttlSec);
    return this.afterLocalChange();
  }

  async unblock(cidr: string): Promise<BlockEffect> {
    await this.local.remove(cidr);
    return this.afterLocalChange();
  }

  private async afterLocalChange(): Promise<BlockEffect> {
    if (!this.deps.aws.enabled) {
      return { effective: 'after-reload', synced: false, detail: '无凭证：只写入本地 denylist（Nginx reload 后生效），未同步到 AWS WAF' };
    }
    try {
      const r = await this.sync();
      return { effective: 'propagating', synced: true, detail: `已同步到 IP 集合 ${this.deps.cfg.waf.WAF_IP_SET_NAME}（+${r.added} −${r.removed}），正在传播到边缘` };
    } catch (e) {
      return { effective: 'after-reload', synced: false, detail: `本地 denylist 已生效；同步到 AWS WAF 失败：${describeAwsError(e)}（worker 每分钟重试）` };
    }
  }

  /** 最近一次同步结果：本进程的，或 security/waf-sync.json 中较新的那一个（worker 写入） */
  async syncState(): Promise<SyncState | undefined> {
    let fromFile: SyncState | undefined;
    try {
      fromFile = JSON.parse(await readFile(this.syncStateFile, 'utf8')) as SyncState;
    } catch {
      /* 还没有同步过 */
    }
    if (!this.lastSync) return fromFile;
    if (!fromFile) return this.lastSync;
    return Date.parse(fromFile.at) > Date.parse(this.lastSync.at) ? fromFile : this.lastSync;
  }

  private async recordSync(s: SyncState): Promise<void> {
    this.lastSync = s;
    try {
      await mkdir(path.dirname(this.syncStateFile), { recursive: true });
      const tmp = `${this.syncStateFile}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(s)}\n`, { encoding: 'utf8', mode: 0o640 });
      await rename(tmp, this.syncStateFile);
    } catch {
      /* 只影响跨进程可见性 */
    }
  }

  /** denylist（未过期的 IPv4 条目）→ IP 集合，整体替换；并发调用共用一次 */
  sync(): Promise<SyncResult> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async doSync(): Promise<SyncResult> {
    const w = this.deps.cfg.waf;
    const at = () => new Date(this.now()).toISOString();
    try {
      if (!this.deps.aws.enabled) throw Object.assign(new Error('IAM_CREDENTIALS=none：不能写 IP 集合'), { name: 'AwsCredentialsUnavailableError' });
      if (!w.WAF_IP_SET_ID || !w.WAF_IP_SET_NAME) throw new Error('WAF_IP_SET_ID / WAF_IP_SET_NAME 未配置（waf 栈的 Outputs）');
      const want = desiredAddresses(await this.local.list(), this.now());
      const sdk = await loadAwsPackage('@aws-sdk/client-wafv2', () => import('@aws-sdk/client-wafv2'));
      const waf = await this.deps.aws.wafv2({ region: this.detector.region() });
      const key = { Name: w.WAF_IP_SET_NAME, Scope: this.scope, Id: w.WAF_IP_SET_ID };
      for (let attempt = 1; ; attempt += 1) {
        const got = await withAwsRetry(() => waf.send(new sdk.GetIPSetCommand(key)), { attempts: 3, timeoutMs: 5000 });
        const current = got.IPSet?.Addresses ?? [];
        const d = diffAddresses(current, want.addresses);
        const result: SyncResult = { added: d.add.length, removed: d.remove.length, total: want.addresses.length, skippedIpv6: want.skippedIpv6, unchanged: d.same };
        if (d.same) {
          await this.recordSync({ at: at(), ok: true, role: this.deps.role, result });
          return result;
        }
        try {
          await withAwsRetry(() => waf.send(new sdk.UpdateIPSetCommand({
            ...key, Addresses: want.addresses, LockToken: got.LockToken!,
            // Update* 整体替换可变字段：不带 Description 会清空它
            ...(got.IPSet?.Description ? { Description: got.IPSet.Description } : {}),
          })), { attempts: 3, timeoutMs: 5000 });
          await this.recordSync({ at: at(), ok: true, role: this.deps.role, result });
          this.deps.logger?.info('waf: IP 集合已同步', { ...result });
          return result;
        } catch (e) {
          if (awsErrorName(e) === 'WAFOptimisticLockException' && attempt < MAX_LOCK_RETRIES) continue;
          throw e;
        }
      }
    } catch (e) {
      await this.recordSync({ at: at(), ok: false, role: this.deps.role, error: describeAwsError(e) });
      throw e;
    }
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const entries = await this.local.list().catch(() => undefined);
    const want = entries ? desiredAddresses(entries, this.now()) : undefined;
    const [det, local, sync] = await Promise.all([
      this.detector.detect({ ...(opts.deep ? { deep: true } : {}), ...(want ? { desired: want.addresses } : {}) }),
      this.local.probe(),
      this.syncState(),
    ]);
    let status = det.status;
    const notes: string[] = [];
    const worse = (s: ProbeResult['status']) => {
      const rank = { ok: 0, degraded: 1, error: 2 } as const;
      if (rank[s] > rank[status]) status = s;
    };
    if (local.status !== 'ok') {
      worse(local.status);
      notes.push(local.detail);
    }
    if (sync && !sync.ok) {
      worse('degraded');
      notes.push(`IP 集合同步落后：最近一次同步失败（${sync.at}）：${sync.error ?? '?'}`);
    }
    if (want?.skippedIpv6) notes.push(`${want.skippedIpv6} 条 IPv6 封禁只在本地 Nginx 生效（IP 集合是 IPV4）`);
    const count = entries?.length ?? 0;
    return {
      ...det,
      status,
      detail: `${det.detail} · denylist ${count} 条${sync?.ok ? `（${sync.at} 已同步到 IP 集合）` : ''}${notes.length ? ` · ${notes.join('；')}` : ''}`,
      data: {
        ...(det.data ?? {}),
        denylist: local.data ?? {},
        ...(sync ? { lastSync: sync } : {}),
        ...(want ? { desiredIpv4: want.addresses.length, skippedIpv6: want.skippedIpv6 } : {}),
      },
    };
  }
}
