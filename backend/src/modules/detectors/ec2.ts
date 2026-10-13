// backend/src/modules/detectors/ec2.ts —— ec2 基础模块的本机健康项（00-ec2-base.md 第 5、7 节）
//
// 脚手架只实现与平台无关的两项（disk、memory），保证 L0 下 ec2 有可用的状态；其余检查项
// （imdsv2、data-volume、key-fingerprint、nginx、processes、time-sync、timers、security-snapshot、fail2ban、manual-dropins）
// 由「L0 本地实现者」补齐：只读本机（IMDSv2、/proc、statfs、security/snapshot.json），不调用 AWS API。
import { existsSync, statfsSync } from 'node:fs';
import os from 'node:os';
import type { CapabilityCheck } from '@cloudalbum/contracts';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

function worst(checks: CapabilityCheck[]): ProbeResult['status'] {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'ok';
}

export class Ec2Detector implements Detector {
  readonly module = 'ec2' as const;
  constructor(private readonly ctx: DetectorContext) {}

  async detect(): Promise<ProbeResult> {
    const checks: CapabilityCheck[] = [];
    const dataDir = this.ctx.cfg.core.CLOUDALBUM_DATA_DIR;
    if (existsSync(dataDir)) {
      try {
        const s = statfsSync(dataDir);
        const freePct = s.blocks > 0 ? Math.round((s.bavail / s.blocks) * 100) : 0;
        checks.push({ id: 'disk', status: freePct < 5 ? 'error' : freePct < 15 ? 'degraded' : 'ok', detail: `数据目录剩余 ${freePct}%` });
      } catch (e) {
        checks.push({ id: 'disk', status: 'error', detail: `statfs 失败：${(e as Error).message}` });
      }
    } else {
      checks.push({ id: 'disk', status: 'degraded', detail: `数据目录 ${dataDir} 不存在` });
    }
    const availPct = Math.round((os.freemem() / os.totalmem()) * 100);
    checks.push({ id: 'memory', status: availPct < 10 ? 'degraded' : 'ok', detail: `可用内存 ${availPct}%` });
    return {
      status: worst(checks),
      detail: `${os.hostname()} · ${process.platform}/${process.arch} · node ${process.version} · ${checks.map((c) => c.detail).join(' · ')}`,
      confidence: 'inferred',
      data: { hostname: os.hostname(), platform: process.platform, arch: process.arch, node: process.version, checks },
    };
  }
}

export const ec2Detector: DetectorFactory = { module: 'ec2', create: (ctx) => new Ec2Detector(ctx) };
