// 显示用的格式化（数字用等宽表格数字，单位紧跟数字）。

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtMs(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} ms`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 60) return `${f} 秒后`;
    if (f < 3600) return `${Math.round(f / 60)} 分钟后`;
    if (f < 86400) return `${Math.round(f / 3600)} 小时后`;
    return `${Math.round(f / 86400)} 天后`;
  }
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)} 天前`;
  return fmtTime(iso).slice(0, 10);
}

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return '—';
  return id.length > n + 2 ? `${id.slice(0, n)}…` : id;
}

const ENTRY_LABEL: Record<string, string> = {
  nginx: 'Nginx', alb: 'ALB', waf: 'WAF', cloudfront: 'CloudFront', apigw: 'API Gateway', lambda: 'Lambda', direct: '直连（开发机，无 Nginx）',
};

/** `cloudfront>waf>alb>nginx` → `CloudFront → WAF → ALB → Nginx` */
export function entryChainLabel(entry: string | undefined): string {
  if (!entry) return '未知';
  return entry.split('>').map((s) => ENTRY_LABEL[s] ?? s).join(' → ');
}
