// 邮件正文预览（/me/outbox 与 /admin/outbox 共用）：iframe sandbox + srcdoc，CSP 禁止脚本和外部资源（04 组 email 第 1 节）。
// 邮件里的链接另外解析出来列在下方（只列 http/https），这就是 L0 下“收到邮件”的等价物：点验证链接即可完成验证。
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { OutboxEmailDetail } from '../api/types';
import { fmtTime } from '../util/format';

const CSP = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";

export function buildSrcDoc(html: string | null | undefined, text: string | null | undefined): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><base target="_blank"><style>body{font:14px/1.6 system-ui,sans-serif;margin:12px;color:#1c1d1f;background:#fff;word-break:break-word}</style>`;
  if (html) return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  const esc = (text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  return `<!doctype html><html><head>${head}</head><body><pre style="white-space:pre-wrap;font:inherit">${esc}</pre></body></html>`;
}

/** 从 HTML（不执行）或纯文本里取出 http/https 链接 */
export function extractLinks(html: string | null | undefined, text: string | null | undefined): string[] {
  const out = new Set<string>();
  if (html && typeof DOMParser === 'function') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) out.add(href);
    }
  }
  for (const m of (text ?? '').matchAll(/https?:\/\/[^\s<>"')]+/g)) out.add(m[0]);
  return [...out];
}

/** 本站链接（例如验证链接 /verify?…）在当前标签页内用路由打开 */
export function sameOriginPath(href: string): string | null {
  try {
    const u = new URL(href, globalThis.location?.href);
    return u.origin === globalThis.location?.origin ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}

export function MailPreview({ mail }: { mail: OutboxEmailDetail }) {
  const srcDoc = useMemo(() => buildSrcDoc(mail.html, mail.text), [mail.html, mail.text]);
  const links = useMemo(() => extractLinks(mail.html, mail.text), [mail.html, mail.text]);
  const hasBody = mail.hasBody ?? Boolean(mail.html || mail.text);
  return (
    <div className="stack">
      <dl className="kv">
        <dt>主题</dt><dd>{mail.subject}</dd>
        {mail.from && (<><dt>发件人</dt><dd className="mono">{mail.from}</dd></>)}
        <dt>收件人</dt><dd className="mono">{mail.to.join(', ')}</dd>
        <dt>类别</dt><dd>{mail.category}</dd>
        <dt>发送方式</dt><dd>{mail.transport === 'ses' ? 'Amazon SES' : '本地 outbox（未真正发出）'} · {mail.status}{mail.deliveryStatus !== 'none' ? ` · ${mail.deliveryStatus}` : ''}</dd>
        <dt>时间</dt><dd>{fmtTime(mail.createdAt)}</dd>
        {mail.error && (<><dt>错误</dt><dd className="status-err">{mail.error}</dd></>)}
      </dl>
      {hasBody ? (
        <iframe className="mail-frame" title={`邮件：${mail.subject}`} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} />
      ) : (
        <p className="notice">邮件已由 Amazon SES 发出，这里只有发送记录，没有正文。请查收邮箱。</p>
      )}
      {links.length > 0 && (
        <div>
          <strong>邮件中的链接</strong>
          <ul>
            {links.map((l) => {
              const local = sameOriginPath(l);
              return (
                <li key={l}>
                  {local
                    ? <Link className="wrap-any" to={local}>{l}</Link>
                    : <a className="wrap-any" href={l} target="_blank" rel="noreferrer noopener">{l}</a>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {mail.emlUrl && <a className="btn btn-sm" href={mail.emlUrl} download>下载 .eml</a>}
    </div>
  );
}
