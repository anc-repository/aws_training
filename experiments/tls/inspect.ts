/**
 * tls/inspect —— 各入口的证书（01#tls 第 5 节步骤 1、6）。
 *
 *   npm run exp -- tls --label before --scenario inspect          # 自签名（CN=cloudalbum-l0）或本地档 Let's Encrypt
 *   scripts/module enable tls --domain <域名>
 *   npm run exp -- tls --label after  --scenario inspect --upload # ACM：ACME → Nginx，或 CloudFront / ALB 上的集成证书
 *
 * 对每个入口（直连 EIP:443 + SNI=TLS_DOMAIN、CDN、有效入口 URL）做一次全新握手，记录签发者、主题、SAN、有效期、剩余天数、
 * 协议版本、加密套件、ALPN、证书链是否受信任。服务端证据：capabilities.https（受信 HTTPS 判定）与 tls 感知器在实例上的握手结果。
 * 证据之外再经入口请求 /api/health/live，读 X-CloudAlbum-Path 的 tls 段（例如 acm@nginx:acme、selfsigned@cloudfront:cf-default）。
 */
import { timedGet } from '../_lib/probe.js';
import { defineScenario } from '../_lib/scenario.js';
import { certKind, inspectEntry, serverEvidence, tlsEntries } from './lib.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const entries = tlsEntries(ctx);
    if (!entries.length) {
      ctx.note('没有可测的入口（--param hosts=direct=<EIP>,cdn=<分配域名>）');
      return;
    }
    const certs = [];
    for (const e of entries) {
      const c = await inspectEntry(e);
      const path = await timedGet(`https://${e.servername && !/^\d/.test(e.servername) ? e.servername : e.host}/api/health/live`, {}, 8000);
      const seg = /(?:^|;)tls=([^;]+)/.exec(path.headers['x-cloudalbum-path'] ?? '')?.[1];
      certs.push({ ...c, kind: certKind(c), pathTls: seg ?? null });
    }
    ctx.finding('entries', certs);
    ctx.finding('trustedEntries', certs.filter((c) => c.trusted).length);
    ctx.finding('direct', certs.find((c) => c.entry === 'direct') ?? null);
    ctx.finding('server', await serverEvidence(ctx));
  },
});
