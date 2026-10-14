// tls 感知器（01#tls 第 3、10 节）：各入口握手结果的判定（签发者、SAN、到期、续期窗口、续期定时器）、缓存、终止点 via，
// 深度探针（ACM DescribeCertificate / SearchCertificates；aws-sdk-client-mock）
import { createServer } from 'node:net';
import { ACMClient, DescribeCertificateCommand, SearchCertificatesCommand } from '@aws-sdk/client-acm';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { TlsDetector, nodeHandshake, sanCovers, type HandshakeResult, type TlsTarget } from '../../src/modules/detectors/tls.js';
import { ENABLE } from '../helpers/config.js';
import { awsError, fakeCredentials, testConfig } from '../adapters/aws/helpers.js';

const acm = mockClient(ACMClient);
afterEach(() => acm.reset());

const NOW = Date.parse('2026-10-14T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function cert(t: TlsTarget, o: Partial<HandshakeResult> & { from?: number; to?: number } = {}): HandshakeResult {
  const from = o.from ?? NOW - 5 * DAY;
  const to = o.to ?? from + 45 * DAY;
  return {
    entry: t.entry, host: t.host, port: t.port, ok: true, issuer: 'Amazon', issuerCn: 'Amazon RSA 2048 M03', subject: 'album.example.com',
    sans: ['album.example.com'], validFrom: iso(from), validTo: iso(to), protocol: 'TLSv1.3', alpn: 'h2', chainTrusted: true, ...o,
  };
}

const SELF: Partial<HandshakeResult> = { issuer: 'cloudalbum-l0', issuerCn: 'cloudalbum-l0', subject: 'cloudalbum-l0', sans: ['203.0.113.10'], chainTrusted: false, from: NOW - 100 * DAY, to: NOW + 700 * DAY };

function detector(env: Record<string, string>, opts: {
  hs?: (t: TlsTarget) => HandshakeResult | Promise<HandshakeResult>; creds?: boolean; renew?: { ok?: boolean; at?: string; exitCode?: number };
  now?: () => number;
} = {}) {
  const { cfg, effective } = testConfig(env);
  const calls: TlsTarget[] = [];
  const d = new TlsDetector({ cfg, env: effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: opts.creds === false ? null : fakeCredentials }) }, {
    now: opts.now ?? (() => NOW),
    handshake: async (t) => { calls.push(t); return (opts.hs ?? ((x) => cert(x)))(t); },
    readRenewStatus: async () => opts.renew,
  });
  return { d, calls };
}

describe('TlsDetector：常规探针（握手，不需要凭证）', () => {
  it('ACME：直连证书由 Amazon 签发、SAN 覆盖 TLS_DOMAIN、未到续期点 → ok，via=acm@nginx:acme', async () => {
    const { d, calls } = detector({ ...ENABLE.tlsAcme });
    const r = await d.detect({});
    expect(r.status).toBe('ok');
    expect(calls).toEqual([{ entry: 'direct', host: '127.0.0.1', port: 443, servername: 'album.example.com' }]);
    expect(r.data).toMatchObject({ via: 'acm@nginx:acme', trusted: true, entries: [{ entry: 'direct', kind: 'acme', daysLeft: 40, lifetimeDays: 45, renewal: 'certbot 定时器' }] });
    expect(r.detail).toContain('direct=acme（剩 40 天）');
  });

  it('TLS_ACME=on 但直连仍是自签名（符号链接未切换）→ degraded，不按域名不匹配报 error', async () => {
    const { d } = detector({ ...ENABLE.tlsAcme }, { hs: (t) => cert(t, SELF) });
    const r = await d.detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('不是 Amazon');
    expect(r.data).toMatchObject({ via: 'selfsigned@nginx', trusted: false });
  });

  it('证书过期 → error；Amazon 签发却不覆盖域名 → error', async () => {
    const expired = await detector({ ...ENABLE.tlsAcme }, { hs: (t) => cert(t, { from: NOW - 50 * DAY, to: NOW - DAY }) }).d.detect({});
    expect(expired.status).toBe('error');
    expect(expired.detail).toContain('已过期');
    const mismatch = await detector({ ...ENABLE.tlsAcme }, { hs: (t) => cert(t, { sans: ['other.example.com'] }) }).d.detect({});
    expect(mismatch.status).toBe('error');
    expect(mismatch.detail).toContain('不覆盖 album.example.com');
  });

  it('续期窗口：45 天证书只剩 10 天（< 寿命的 1/3 - 2）→ degraded；续期定时器最近一次失败 → degraded', async () => {
    const late = await detector({ ...ENABLE.tlsAcme }, { hs: (t) => cert(t, { from: NOW - 35 * DAY }) }).d.detect({});
    expect(late.status).toBe('degraded');
    expect(late.detail).toContain('只剩 10 天');
    const timer = await detector({ ...ENABLE.tlsAcme }, { renew: { ok: false, at: '2026-10-13T12:00:00Z', exitCode: 1 } }).d.detect({});
    expect(timer.status).toBe('degraded');
    expect(timer.detail).toContain('cloudalbum-tls-renew 最近一次运行失败');
  });

  it('回退分支（TLS_ACME=off）：直连自签名是预期，CloudFront 上的集成证书覆盖别名 → ok，via=acm@cloudfront', async () => {
    const env = {
      MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'lab.example.com', TLS_ACME: 'off',
      ACM_CERT_ARN_EDGE: 'arn:aws:acm:us-east-1:123456789012:certificate/edge', CDN_BASE_URL: 'https://lab.example.com', MODULE_CDN: 'on',
      APP_BASE_URL: 'https://lab.example.com',
    };
    const { d, calls } = detector(env, {
      hs: (t) => (t.entry === 'direct' ? cert(t, SELF) : cert(t, { sans: ['lab.example.com'], from: NOW - 10 * DAY, to: NOW + 188 * DAY })),
    });
    const r = await d.detect({});
    expect(calls.map((c) => c.entry)).toEqual(['direct', 'cdn']);
    expect(r.status).toBe('ok');
    expect(r.data).toMatchObject({ via: 'acm@cloudfront', trusted: true, entries: [{ kind: 'selfsigned' }, { kind: 'acm', renewal: 'ACM 托管' }] });
  });

  it('CloudFront 默认证书（tls 只在 Nginx）→ via=selfsigned@cloudfront:cf-default', async () => {
    const env = { ...ENABLE.tlsAcme, CDN_BASE_URL: 'https://d111.cloudfront.net', MODULE_CDN: 'on' };
    const r = await detector(env, { hs: (t) => (t.entry === 'cdn' ? cert(t, { sans: ['cloudfront.net', '*.cloudfront.net'], subject: '*.cloudfront.net', from: NOW - 30 * DAY, to: NOW + 300 * DAY }) : cert(t)) }).d.detect({});
    expect(r.status).toBe('ok');
    expect(r.data).toMatchObject({ via: 'selfsigned@cloudfront:cf-default' });
  });

  it('远端入口握手超时 → error + transient（首次探针只记 degraded）；直连拒绝连接 → error', async () => {
    const env = { ...ENABLE.tlsAcme, CDN_BASE_URL: 'https://d111.cloudfront.net', MODULE_CDN: 'on' };
    const r = await detector(env, { hs: (t) => (t.entry === 'cdn' ? { entry: t.entry, host: t.host, port: t.port, ok: false, error: 'TIMEOUT', sans: [] } : cert(t)) }).d.detect({});
    expect(r).toMatchObject({ status: 'error', transient: true });
    const refused = await detector({ ...ENABLE.tlsAcme }, { hs: (t) => ({ entry: t.entry, host: t.host, port: t.port, ok: false, error: 'ECONNREFUSED', sans: [] }) }).d.detect({});
    expect(refused.status).toBe('error');
    expect(refused.transient).toBeUndefined();
  });

  it('握手结果缓存 300 秒（registry probe.intervalSec）；deep 时重测', async () => {
    let t = NOW;
    const { d, calls } = detector({ ...ENABLE.tlsAcme }, { now: () => t });
    await d.detect({});
    t += 60_000;
    await d.detect({});
    expect(calls).toHaveLength(1);
    t += 300_000;
    await d.detect({});
    expect(calls).toHaveLength(2);
    await d.detect({ deep: true }).catch(() => undefined);
    expect(calls).toHaveLength(3);
  });

  it('sanCovers：精确匹配与单层通配符', () => {
    expect(sanCovers(['album.example.com'], 'Album.Example.com')).toBe(true);
    expect(sanCovers(['*.example.com'], 'album.example.com')).toBe(true);
    expect(sanCovers(['*.example.com'], 'a.b.example.com')).toBe(false);
    expect(sanCovers(['*.example.com'], 'example.com')).toBe(false);
  });

  it('nodeHandshake：连接被拒绝 / 对端不是 TLS 时返回 ok=false（不抛异常）', async () => {
    const srv = createServer((s) => s.end('not tls\n'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const r = await nodeHandshake({ entry: 'direct', host: '127.0.0.1', port }, 2000);
    srv.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('TlsDetector：深度探针（ACM 控制面）', () => {
  it('ACME：SearchCertificates 找到 ISSUED 的 ACME 证书 → ok（confirmed）', async () => {
    acm.on(SearchCertificatesCommand).resolves({
      Results: [{
        CertificateArn: 'arn:aws:acm:ap-northeast-1:123456789012:certificate/acme-1',
        X509Attributes: { Subject: { CommonName: 'album.example.com' }, NotAfter: new Date(NOW + 40 * DAY) },
        CertificateMetadata: { AcmCertificateMetadata: { Status: 'ISSUED', CertificateKeyPairOrigin: 'ACME', AcmeEndpointArn: 'arn:aws:acm:ap-northeast-1:123456789012:acme-endpoint/e1' } },
      }],
    });
    const r = await detector({ ...ENABLE.tlsAcme }).d.detect({ deep: true });
    expect(r).toMatchObject({ status: 'ok', confidence: 'confirmed' });
    expect(r.data).toMatchObject({ acmeCertificates: [{ status: 'ISSUED' }] });
    const input = acm.commandCalls(SearchCertificatesCommand)[0]!.args[0].input;
    expect(input.FilterStatement).toEqual({ Filter: { AcmCertificateMetadataFilter: { CertificateKeyPairOrigin: 'ACME' } } });
  });

  it('ACME 证书全部被吊销 → error；没找到 → degraded', async () => {
    acm.on(SearchCertificatesCommand).resolves({
      Results: [{ CertificateArn: 'arn:x', X509Attributes: { Subject: { CommonName: 'album.example.com' } }, CertificateMetadata: { AcmCertificateMetadata: { Status: 'REVOKED' } } }],
    });
    expect((await detector({ ...ENABLE.tlsAcme }).d.detect({ deep: true })).status).toBe('error');
    acm.reset();
    acm.on(SearchCertificatesCommand).resolves({ Results: [] });
    expect((await detector({ ...ENABLE.tlsAcme }).d.detect({ deep: true })).status).toBe('degraded');
  });

  it('集成证书：续期失败 → degraded；证书不存在 → error；无凭证 → degraded（CRED-004）', async () => {
    const env = {
      MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'lab.example.com', TLS_ACME: 'off',
      ACM_CERT_ARN_EDGE: 'arn:aws:acm:us-east-1:123456789012:certificate/edge', CDN_BASE_URL: 'https://lab.example.com', MODULE_CDN: 'on',
    };
    const hs = (t: TlsTarget) => (t.entry === 'direct' ? cert(t, SELF) : cert(t, { sans: ['lab.example.com'], to: NOW + 150 * DAY }));
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: { CertificateArn: env.ACM_CERT_ARN_EDGE, Status: 'ISSUED', InUseBy: ['arn:aws:cloudfront::123456789012:distribution/E1'], RenewalSummary: { RenewalStatus: 'FAILED', DomainValidationOptions: [], UpdatedAt: new Date() } },
    });
    const failed = await detector(env, { hs }).d.detect({ deep: true });
    expect(failed.status).toBe('degraded');
    expect(failed.detail).toContain('续期状态 FAILED');
    acm.reset();
    acm.on(DescribeCertificateCommand).rejects(awsError('ResourceNotFoundException', 400));
    expect((await detector(env, { hs }).d.detect({ deep: true })).status).toBe('error');
    const noCreds = await detector(env, { hs, creds: false }).d.detect({ deep: true });
    expect(noCreds.status).toBe('degraded');
    expect(noCreds.detail).toContain('CRED-004');
  });
});
