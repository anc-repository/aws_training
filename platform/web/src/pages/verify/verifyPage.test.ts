import { afterEach, describe, expect, it } from 'vitest';
import pageHtml from '../../../public-pages/verify/index.html?raw';
import { reportDigest } from './verifyCore';
import { certIdFromPath, evaluate, jwsFromHash, jwsFromInput, LEGACY_SEQ_KEY, mount, SEQ_KEY, type TextResponse, type VerifyEnv } from './verifyPage';
import { resultCard, type PageResult } from './verifyView';
import { CERT_ID, certPayload, jwksOf, makeKey, revocations, sampleReport, signJws, type TestKey } from './testFixtures';

function loadPage(): void {
  const dom = new DOMParser().parseFromString(pageHtml, 'text/html');
  document.body.replaceWith(document.importNode(dom.body, true));
}

afterEach(() => {
  document.body.replaceChildren();
});

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), m };
}

interface Site {
  certs?: Record<string, string>;
  jwks?: string | null;
  revocations?: string | null;
  offline?: boolean;
}

function fetchFor(site: Site) {
  const calls: string[] = [];
  const fetchText = async (path: string): Promise<TextResponse | null> => {
    calls.push(path);
    if (site.offline) return null;
    if (path === '/.well-known/atl/jwks.json') return site.jwks == null ? { ok: false, status: 403, text: '' } : { ok: true, status: 200, text: site.jwks };
    if (path === '/public/revocations.jws') return site.revocations == null ? { ok: false, status: 403, text: '' } : { ok: true, status: 200, text: `${site.revocations}\n` };
    const m = /^\/public\/certs\/(.+)\.jws$/.exec(path);
    if (m && site.certs?.[m[1]!]) return { ok: true, status: 200, text: `${site.certs[m[1]!]}\n` };
    return { ok: false, status: 403, text: '' };
  };
  return { fetchText, calls };
}

async function site(key: TestKey, opts: { revoked?: boolean; seq?: number; payload?: Record<string, unknown> } = {}) {
  const jws = await signJws(key, 'atl-cert+jws', certPayload(opts.payload));
  const rev = await revocations(key, opts.seq ?? 12, opts.revoked ? [{ certId: CERT_ID, revokedAt: '2026-10-22T03:00:00Z', reason: 'superseded' }] : []);
  return { jws, s: { certs: { [CERT_ID]: jws }, jwks: JSON.stringify(jwksOf([key])), revocations: rev } satisfies Site };
}

function env(f: ReturnType<typeof fetchFor>, loc: { pathname: string; hash?: string }, storage = memStore()): VerifyEnv {
  return { doc: document, location: { pathname: loc.pathname, hash: loc.hash ?? '' }, fetchText: f.fetchText, subtle: crypto.subtle, storage };
}

describe('static entry contract (08 P09-V, §6.11 D-UI-7; 04 §10.6)', () => {
  it('no inline styles or scripts; same-origin stylesheet and script; status region', () => {
    expect(pageHtml).not.toMatch(/<style/i);
    expect(pageHtml).not.toMatch(/\sstyle=/i);
    expect(pageHtml).not.toMatch(/<script>(?!\s*<\/script>)/i);
    expect(pageHtml).toContain('<script src="/verify/verify.js" defer></script>');
    expect(pageHtml).toContain('<link rel="stylesheet" href="/verify/verify.css">');
    expect(pageHtml).not.toContain("'unsafe-inline'");
    expect(pageHtml).toMatch(/id="vres"[^>]*role="status"/);
    expect(pageHtml).toContain('不是 AWS 官方认证');
  });
});

describe('inputs', () => {
  it('cert id from the path, JWS from the fragment or from pasted text / offline bundle', () => {
    expect(certIdFromPath(`/verify/${CERT_ID}`)).toBe(CERT_ID);
    expect(certIdFromPath(`/verify/${CERT_ID.toLowerCase()}/`)).toBe(CERT_ID);
    expect(certIdFromPath('/verify/')).toBeNull();
    expect(certIdFromPath('/verify/index.html')).toBeNull();
    expect(jwsFromHash('#jws=a.b.c')).toBe('a.b.c');
    expect(jwsFromHash('#x=1')).toBeNull();
    expect(jwsFromInput('  a.b\n.c ')).toBe('a.b.c');
    expect(jwsFromInput(JSON.stringify({ schema: 'atl.offline-verify/v1', jws: 'x.y.z' }))).toBe('x.y.z');
  });
});

describe('evaluate (12 results of 08 P09-V)', () => {
  it('valid from /verify/<certId>, then anti-rollback warns on an older list', async () => {
    const key = await makeKey();
    const { s } = await site(key, { seq: 12 });
    const store = memStore();
    const r1 = await evaluate(env(fetchFor(s), { pathname: `/verify/${CERT_ID}` }, store));
    expect(resultCard(r1).id).toBe('valid');
    expect(store.m.get(SEQ_KEY)).toBe('12');
    const older = await site(key, { seq: 11 });
    const r2 = await evaluate(env(fetchFor(older.s), { pathname: `/verify/${CERT_ID}` }, store));
    expect(resultCard(r2)).toMatchObject({ id: 'revocations-rollback', tone: 'warn', title: '签名有效 · 吊销列表可能是旧版本' });
    // 旧验证页的键也算
    const legacy = memStore({ [LEGACY_SEQ_KEY]: '20' });
    expect(resultCard(await evaluate(env(fetchFor(s), { pathname: `/verify/${CERT_ID}` }, legacy))).id).toBe('revocations-rollback');
  });

  it('not public, no input, network error, unsupported browser, unknown key, revoked', async () => {
    const key = await makeKey();
    const { s, jws } = await site(key);
    expect(resultCard(await evaluate(env(fetchFor({ ...s, certs: {} }), { pathname: `/verify/${CERT_ID}` }))).id).toBe('not-public');
    expect(resultCard(await evaluate(env(fetchFor(s), { pathname: '/verify/' }))).id).toBe('no-input');
    expect(resultCard(await evaluate(env(fetchFor({ ...s, offline: true }), { pathname: `/verify/${CERT_ID}` }))).id).toBe('network');
    expect(resultCard(await evaluate(env(fetchFor({ ...s, jwks: null }), { pathname: '/verify/', hash: `#jws=${jws}` }))).id).toBe('network');
    expect(resultCard(await evaluate({ ...env(fetchFor(s), { pathname: '/verify/', hash: `#jws=${jws}` }), subtle: null })).id).toBe('unsupported');
    const other = await makeKey('another-kid');
    expect(resultCard(await evaluate(env(fetchFor({ ...s, jwks: JSON.stringify(jwksOf([other])) }), { pathname: `/verify/${CERT_ID}` }))).id).toBe('unknown-key');
    const rv = await site(key, { revoked: true });
    const card = resultCard(await evaluate(env(fetchFor(rv.s), { pathname: `/verify/${CERT_ID}` })));
    expect(card).toMatchObject({ id: 'revoked', tone: 'bad' });
    expect(card.detail).toContain('被新证书取代');
    expect(resultCard(await evaluate(env(fetchFor({ ...s, revocations: null }), { pathname: `/verify/${CERT_ID}` }))).id).toBe('revocations-unavailable');
  });

  it('pasted text wins over the path; a fragment JWS is used without fetching the cert file', async () => {
    const key = await makeKey();
    const { s, jws } = await site(key);
    const f = fetchFor({ ...s, certs: {} });
    expect(resultCard(await evaluate(env(f, { pathname: '/verify/', hash: `#jws=${jws}` }))).id).toBe('valid');
    expect(f.calls.some((c) => c.startsWith('/public/certs/'))).toBe(false);
    expect(resultCard(await evaluate(env(f, { pathname: `/verify/${CERT_ID}` }), 'garbage')).id).toBe('malformed');
  });

  it('every result card has shape + text (08 §6.2)', () => {
    const kinds: PageResult[] = [{ kind: 'verifying' }, { kind: 'no-input' }, { kind: 'not-public', certId: CERT_ID }, { kind: 'unsupported' }, { kind: 'network' }];
    for (const k of kinds) {
      const c = resultCard(k);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.shape).toBeTruthy();
    }
  });
});

describe('page rendering (jsdom)', () => {
  it('renders the result, masked details and the per-card report check', async () => {
    loadPage();
    const key = await makeKey();
    const report = sampleReport('svc-cdn');
    const digest = await reportDigest(crypto.subtle, report);
    const payload = certPayload({ subject: { displayName: '张三 111122223333', ref: 'x' } });
    (payload.achievement as { labs: { reportDigest: string | null }[] }).labs[0]!.reportDigest = digest;
    const { s } = await site(key, { payload });
    const page = mount(env(fetchFor(s), { pathname: `/verify/${CERT_ID}` }));
    const r = await page.run();
    expect(r.kind).toBe('outcome');
    const box = document.getElementById('vres')!;
    expect(box.getAttribute('role')).toBe('status');
    expect(box.className).toBe('vres ok');
    expect(box.getAttribute('data-result')).toBe('valid');
    expect(document.getElementById('vres-title')!.textContent).toBe('签名有效');
    const details = document.getElementById('vdetails')!;
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('七项点名对比证书');
    expect(details.textContent).toContain('••••3333');
    expect(details.textContent).not.toContain('111122223333');
    expect(details.textContent).toContain('未吊销（列表序号 12，签名有效）');
    const items = document.querySelectorAll('#vlabs-list li');
    expect(items).toHaveLength(2);
    expect(document.getElementById('vlabs-title')!.textContent).toBe('包含的卡片（2）');
    expect(items[1]!.textContent).toContain('含手动');
    // 核对报告文件
    const input = items[0]!.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File([JSON.stringify(report)], 'report.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    const res = items[0]!.querySelector('[role=status]')!;
    await expect.poll(() => res.textContent).toContain('报告一致');
    // 页面不写 style 属性
    expect(document.querySelector('[style]')).toBeNull();
  });

  it('failed verification hides unverified content; retry and paste work', async () => {
    loadPage();
    const key = await makeKey();
    const { s, jws } = await site(key);
    const f = fetchFor({ ...s, offline: true });
    const page = mount(env(f, { pathname: `/verify/${CERT_ID}` }));
    await page.run();
    expect(document.getElementById('vres')!.getAttribute('data-result')).toBe('network');
    expect(document.getElementById('vres-retry')!.hidden).toBe(false);
    expect(document.getElementById('vdetails')!.hidden).toBe(true);

    loadPage();
    const f2 = fetchFor({ ...s, certs: {} });
    const page2 = mount(env(f2, { pathname: `/verify/${CERT_ID}` }));
    await page2.run();
    expect(document.getElementById('vres')!.getAttribute('data-result')).toBe('not-public');
    expect(document.getElementById('vres-paste')!.hidden).toBe(false);
    // 空粘贴：字段下方给出错误
    const form = document.getElementById('vpaste') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(document.getElementById('vpaste-err')!.hidden).toBe(false);
    (document.getElementById('vjws') as HTMLTextAreaElement).value = jws;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await expect.poll(() => document.getElementById('vres')!.getAttribute('data-result')).toBe('valid');
  });
});
