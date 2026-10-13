// backend/src/observability/nginx-log.ts —— Nginx JSON 访问日志（log_format cloudalbum_json，06 PM-18）的解析
//
// 新格式在原有字段之后追加 args、port、run、probe；旧格式的行（没有这些字段）照常解析，只是 run / probe 为空——
// `lab-metrics` 按 run 统计时自然跳过它们，而不是报错。
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export interface NginxLogLine {
  ts: string;
  ip?: string;
  method?: string;
  uri?: string;
  status: number;
  bytes: number;
  cfId: boolean;
  albTrace: boolean;
  path?: string;
  args?: string;
  port?: string;
  run?: string;
  probe: boolean;
}

export function parseNginxLine(line: string): NginxLogLine | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string) => (typeof j[k] === 'string' && j[k] !== '' && j[k] !== '-' ? (j[k] as string) : undefined);
  return {
    ts: str('ts') ?? '',
    ...(str('ip') ? { ip: str('ip')! } : {}),
    ...(str('method') ? { method: str('method')! } : {}),
    ...(str('uri') ? { uri: str('uri')! } : {}),
    status: Number(j.status ?? 0) || 0,
    bytes: Number(j.bytes ?? 0) || 0,
    cfId: Boolean(str('cf_id')),
    albTrace: Boolean(str('alb_trace')),
    ...(str('path') ? { path: str('path')! } : {}),
    ...(str('args') ? { args: str('args')! } : {}),
    ...(str('port') ? { port: str('port')! } : {}),
    ...(str('run') ? { run: str('run')! } : {}),
    probe: j.probe === 1 || j.probe === '1',
  };
}

/** 逐行读取（文件不存在时什么都不做） */
export async function scanNginxLog(files: readonly string[], onLine: (l: NginxLogLine) => void): Promise<number> {
  let n = 0;
  for (const f of files) {
    if (!existsSync(f)) continue;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const raw of rl) {
      const l = parseNginxLine(raw);
      if (l) {
        n += 1;
        onLine(l);
      }
    }
  }
  return n;
}
