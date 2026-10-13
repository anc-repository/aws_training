/**
 * 公开验证页 P09-V 的页面脚本（打包为 `verify/verify.js`，见 public-pages/build.mjs）。
 *
 * 约束（08 P09-V、§6.11、D-UI-7；04 §10.6）：不加载 SPA 与 Cognito，不调用需要登录的接口；只读取同源静态文件
 * `/.well-known/atl/jwks.json`、`/public/revocations.jws`、`/public/certs/<certId>.jws`；CSP `atl-web-verify` 没有 style-src，
 * 所以页面不写任何 style 属性，状态一律切换 class；所有动态内容用 textContent 写入。
 *
 * 输入：路径 `/verify/<certId>`；或片段 `#jws=<紧凑 JWS>`；或页面上的“粘贴证书（JWS）/ 选择证书文件”（也接受离线验证包 JSON）。
 */
import { redactText } from '../share/publicRedact';
import { CERT_ID_RE, checkReportFile, supportsLocalVerify, verifyCertificate, type Jwks, type VerifyOutcome } from './verifyCore';
import { detailRows, labRows, resultCard, showsPayload, type PageResult, type VerifyShape } from './verifyView';

export const JWKS_PATH = '/.well-known/atl/jwks.json';
export const REVOCATIONS_PATH = '/public/revocations.jws';
export const certPath = (certId: string) => `/public/certs/${certId}.jws`;

/** 防回滚（04 §10.6 可选项）：见过的吊销列表最大序号。兼容 atl-certs 旧验证页的键。 */
export const SEQ_KEY = 'atl.verify.revocations-seq.v1';
export const LEGACY_SEQ_KEY = 'atl.revocations.seq';

export interface TextResponse {
  ok: boolean;
  status: number;
  text: string;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface VerifyEnv {
  doc: Document;
  location: Pick<Location, 'pathname' | 'hash'>;
  /** 读取同源静态文件；网络错误时返回 null。 */
  fetchText: (path: string) => Promise<TextResponse | null>;
  subtle: SubtleCrypto | null | undefined;
  storage: KeyValueStore | null;
}

/** 从路径取 certId：`/verify/ATL-XXXX-XXXX-XXXX-XXXX`（可带结尾斜杠或 index.html 之外的后缀时不认）。 */
export function certIdFromPath(pathname: string): string | null {
  const m = /\/verify\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return null;
  let v: string;
  try {
    v = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  const up = v.toUpperCase();
  return CERT_ID_RE.test(up) ? up : null;
}

/** 片段 `#jws=`（也接受 `#jws=…&x=…`）。 */
export function jwsFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h) return null;
  const v = new URLSearchParams(h).get('jws');
  return v && v.trim() ? v.trim() : null;
}

/** 粘贴或文件内容：紧凑 JWS，或离线验证包 / 任意带 `jws` 字段的 JSON。 */
export function jwsFromInput(text: string): string {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { jws?: unknown };
      if (typeof o.jws === 'string') return o.jws.trim();
    } catch {
      /* 不是 JSON：按 JWS 处理 */
    }
  }
  return t.replace(/\s+/g, '');
}

function readSeq(store: KeyValueStore | null): number {
  if (!store) return 0;
  let best = 0;
  for (const k of [SEQ_KEY, LEGACY_SEQ_KEY]) {
    try {
      const n = Number(store.get(k) ?? '0');
      if (Number.isFinite(n) && n > best) best = n;
    } catch {
      /* 存储不可用 */
    }
  }
  return best;
}

function writeSeq(store: KeyValueStore | null, seq: number): void {
  try {
    store?.set(SEQ_KEY, String(seq));
  } catch {
    /* 存储不可用：照常工作 */
  }
}

/** 完整流程（不触碰 DOM）：取 JWS → 读公钥与吊销列表 → 验签 → 防回滚。 */
export async function evaluate(env: Omit<VerifyEnv, 'doc'>, pasted?: string | null): Promise<PageResult> {
  let jws = pasted ? jwsFromInput(pasted) : jwsFromHash(env.location.hash);
  if (!jws) {
    const certId = certIdFromPath(env.location.pathname);
    if (!certId) return { kind: 'no-input' };
    const r = await env.fetchText(certPath(certId));
    if (r === null) return { kind: 'network' };
    if (!r.ok || !r.text.trim()) return { kind: 'not-public', certId };
    jws = r.text.trim();
  }
  if (!(await supportsLocalVerify(env.subtle))) return { kind: 'unsupported' };
  const jr = await env.fetchText(JWKS_PATH);
  if (!jr || !jr.ok) return { kind: 'network' };
  let jwks: Jwks;
  try {
    jwks = JSON.parse(jr.text) as Jwks;
    if (!jwks || !Array.isArray(jwks.keys)) throw new Error('no keys');
  } catch {
    return { kind: 'network' };
  }
  const rr = await env.fetchText(REVOCATIONS_PATH);
  const revocationsJws = rr && rr.ok ? rr.text.trim() : null;
  let outcome: VerifyOutcome;
  try {
    outcome = await verifyCertificate({ jws, jwks, revocationsJws, subtle: env.subtle! });
  } catch {
    return { kind: 'unsupported' };
  }
  let rollback: { seen: number; got: number } | null = null;
  const seq = outcome.revocations.seq;
  if (outcome.revocations.state === 'checked' && seq !== null) {
    const seen = readSeq(env.storage);
    if (seq < seen) rollback = { seen, got: seq };
    else writeSeq(env.storage, seq);
  }
  return { kind: 'outcome', outcome, rollback };
}

// ---------------------------------------------------------------------------------------------------------------
// 渲染

const SVG_NS = 'http://www.w3.org/2000/svg';

const SHAPES: Readonly<Record<VerifyShape, [string, Record<string, string>][]>> = {
  check: [
    ['circle', { cx: '6', cy: '6', r: '5', fill: 'currentColor' }],
    ['path', { class: 'inv', d: 'M3.6 6.2l1.7 1.6 3.2-3.4', 'stroke-width': '1.4', fill: 'none' }],
  ],
  xbox: [
    ['rect', { x: '1', y: '1', width: '10', height: '10', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }],
    ['path', { d: 'M3.5 3.5l5 5M8.5 3.5l-5 5', stroke: 'currentColor', 'stroke-width': '1.3' }],
  ],
  tri: [
    ['path', { d: 'M6 1.2l5 9.4H1z', fill: 'currentColor' }],
    ['path', { class: 'inv', d: 'M6 4.6v3', 'stroke-width': '1.3' }],
    ['circle', { class: 'invf', cx: '6', cy: '9', r: '.7' }],
  ],
  ring: [['circle', { cx: '6', cy: '6', r: '4.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }]],
  clock: [
    ['circle', { cx: '6', cy: '6', r: '4.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }],
    ['path', { d: 'M6 3.4V6l1.8 1.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round' }],
  ],
};

export function shapeSvg(doc: Document, name: VerifyShape): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'shp');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('data-shape', name);
  for (const [tag, attrs] of SHAPES[name]) {
    const e = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.appendChild(e);
  }
  return svg;
}

function byId<T extends HTMLElement>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as T | null;
}

function setText(doc: Document, id: string, text: string): void {
  const e = byId(doc, id);
  if (e) e.textContent = text;
}

function setHidden(doc: Document, id: string, hidden: boolean): void {
  const e = byId(doc, id);
  if (e) e.hidden = hidden;
}

export function render(env: Pick<VerifyEnv, 'doc' | 'subtle'>, r: PageResult): void {
  const { doc } = env;
  const card = resultCard(r);
  const box = byId(doc, 'vres');
  if (box) {
    box.className = `vres ${card.tone}`;
    box.setAttribute('data-result', card.id);
    box.setAttribute('aria-busy', r.kind === 'verifying' ? 'true' : 'false');
  }
  const shape = byId(doc, 'vres-shape');
  if (shape) {
    shape.replaceChildren(shapeSvg(doc, card.shape));
    shape.className = r.kind === 'verifying' ? 'vshape spin' : 'vshape';
  }
  setText(doc, 'vres-title', card.title);
  setText(doc, 'vres-detail', card.detail);
  setHidden(doc, 'vres-detail', !card.detail);
  setHidden(doc, 'vres-retry', !card.retry);
  setHidden(doc, 'vres-paste', !card.paste);

  const dl = byId(doc, 'vdetails');
  const labs = byId(doc, 'vlabs');
  const list = byId(doc, 'vlabs-list');
  if (!showsPayload(r) || r.kind !== 'outcome' || !r.outcome.payload) {
    if (dl) {
      dl.hidden = true;
      dl.replaceChildren();
    }
    if (labs) labs.hidden = true;
    list?.replaceChildren();
    return;
  }
  const p = r.outcome.payload;
  if (dl) {
    dl.replaceChildren();
    for (const row of detailRows(p, r.outcome, r.rollback)) {
      const dt = doc.createElement('dt');
      dt.textContent = row.label;
      const dd = doc.createElement('dd');
      dd.textContent = row.value;
      if (row.title) dd.title = row.title;
      dl.append(dt, dd);
    }
    dl.hidden = false;
  }
  const rows = labRows(p);
  if (labs && list) {
    list.replaceChildren();
    setText(doc, 'vlabs-title', `包含的卡片（${rows.length}）`);
    rows.forEach((row, i) => {
      const li = doc.createElement('li');
      li.className = 'vlab';
      const text = doc.createElement('span');
      text.className = 'vlab-text';
      text.textContent = row.text;
      const label = doc.createElement('label');
      label.className = 'btn sm';
      const input = doc.createElement('input');
      input.type = 'file';
      input.className = 'sr';
      input.accept = 'application/json,.json';
      input.id = `vlab-file-${i}`;
      input.setAttribute('aria-describedby', `vlab-res-${i}`);
      const lt = doc.createElement('span');
      lt.textContent = '核对报告文件…';
      label.append(input, lt);
      const res = doc.createElement('span');
      res.className = 'vlab-res small';
      res.id = `vlab-res-${i}`;
      res.setAttribute('role', 'status');
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (!f || !env.subtle) return;
        res.className = 'vlab-res small pend';
        res.textContent = '正在计算摘要…';
        void readFileText(f).then(async (txt) => {
          const c = await checkReportFile(env.subtle!, p, txt, row.labId);
          const name = redactText(f.name, 'standard');
          if (c.result === 'consistent') {
            res.className = 'vlab-res small ok';
            res.textContent = `报告一致：文件 ${name} 的摘要与证书中的报告摘要相同。文件未上传。`;
          } else if (c.result === 'invalid') {
            res.className = 'vlab-res small bad';
            res.textContent = `文件 ${name} 不是报告 JSON。`;
          } else {
            res.className = 'vlab-res small bad';
            const other = c.labId && c.labId !== row.labId ? `（文件中的报告属于 ${redactText(c.labId, 'standard')}）` : '';
            res.textContent = `报告不一致：文件 ${name} 的摘要 ${(c.digest ?? '—').slice(0, 19)}… 与证书中的 ${(row.digest ?? '—').slice(0, 19)}… 不同${other}。文件未上传。`;
          }
        });
      });
      li.append(text, label, res);
      list.appendChild(li);
    });
    labs.hidden = rows.length === 0;
  }
}

function readFileText(f: Blob): Promise<string> {
  if (typeof f.text === 'function') return f.text();
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result ?? ''));
    rd.onerror = () => reject(rd.error);
    rd.readAsText(f);
  });
}

/** 挂接页面：首次验证、重试、粘贴 / 选择文件、片段变化。返回最后一次结果的 Promise（测试用）。 */
export function mount(env: VerifyEnv): { run: (pasted?: string | null) => Promise<PageResult> } {
  const { doc } = env;
  let seq = 0;
  const run = async (pasted?: string | null): Promise<PageResult> => {
    const my = ++seq;
    render(env, { kind: 'verifying' });
    const r = await evaluate(env, pasted);
    if (my === seq) render(env, r);
    return r;
  };
  byId<HTMLButtonElement>(doc, 'vres-retry')?.addEventListener('click', () => void run());
  byId<HTMLButtonElement>(doc, 'vres-paste')?.addEventListener('click', () => {
    const form = byId(doc, 'vpaste');
    form?.scrollIntoView?.();
    byId<HTMLTextAreaElement>(doc, 'vjws')?.focus();
  });
  const form = byId<HTMLFormElement>(doc, 'vpaste');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = byId<HTMLTextAreaElement>(doc, 'vjws')?.value ?? '';
    if (!v.trim()) {
      setText(doc, 'vpaste-err', '请先粘贴证书（JWS），或选择证书文件。');
      setHidden(doc, 'vpaste-err', false);
      return;
    }
    setHidden(doc, 'vpaste-err', true);
    void run(v);
  });
  const file = byId<HTMLInputElement>(doc, 'vfile');
  file?.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    void readFileText(f).then((txt) => {
      const ta = byId<HTMLTextAreaElement>(doc, 'vjws');
      if (ta) ta.value = jwsFromInput(txt);
      setHidden(doc, 'vpaste-err', true);
      void run(txt);
    });
  });
  return { run };
}

/** 浏览器入口：用真实的 fetch、crypto.subtle 与 localStorage。 */
export function boot(): void {
  const doc = document;
  const env: VerifyEnv = {
    doc,
    location: window.location,
    fetchText: async (path) => {
      try {
        const r = await fetch(path, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
        return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
      } catch {
        return null;
      }
    },
    subtle: globalThis.crypto?.subtle ?? null,
    storage: (() => {
      try {
        const ls = window.localStorage;
        return { get: (k: string) => ls.getItem(k), set: (k: string, v: string) => ls.setItem(k, v) };
      } catch {
        return null;
      }
    })(),
  };
  const page = mount(env);
  void page.run();
  window.addEventListener('hashchange', () => {
    if (jwsFromHash(window.location.hash)) void page.run();
  });
}
