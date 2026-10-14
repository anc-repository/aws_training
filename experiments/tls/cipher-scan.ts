/**
 * tls/cipher-scan —— 协议与加密套件（01#tls 第 5 节步骤 4）。
 *
 *   sudo dnf install -y nmap                                          # CloudShell / 工作台
 *   npm run exp -- tls --label after --scenario cipher-scan
 *
 * 对每个入口执行 `nmap --script ssl-enum-ciphers -p 443 <host>`，解析出各协议版本与套件、最低强度等级，比较 Nginx
 * （ssl_protocols TLSv1.2 TLSv1.3）与 CloudFront（TLSv1.2_2021）/ ALB 安全策略。只扫描自己账号里的资源。
 */
import { spawnSync } from 'node:child_process';
import { defineScenario } from '../_lib/scenario.js';
import { parseSslEnumCiphers, serverEvidence, tlsEntries } from './lib.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const probe = spawnSync('nmap', ['--version'], { encoding: 'utf8', windowsHide: true });
    if (probe.status !== 0) {
      ctx.note('没有 nmap：sudo dnf install -y nmap 后重跑（CloudShell 中安装的工具在会话之间是否保留以官方文档为准）');
      ctx.finding('available', false);
      return;
    }
    const out: Record<string, unknown> = {};
    for (const e of tlsEntries(ctx)) {
      const r = spawnSync('nmap', ['-Pn', '--script', 'ssl-enum-ciphers', '-p', String(e.port), e.host], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
      out[e.entry] = { host: e.host, exit: r.status, ...parseSslEnumCiphers(r.stdout ?? '') };
    }
    ctx.finding('available', true);
    ctx.finding('entries', out);
    ctx.finding('server', await serverEvidence(ctx));
  },
});
