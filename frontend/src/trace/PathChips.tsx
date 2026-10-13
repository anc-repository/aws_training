// 路径芯片（总纲 7.4 第 2 条）：灰 = 本地实现，橙 = AWS 服务，绿 = 缓存命中，红 = 错误，紫 = 管理员旁路（黄 = 降级兜底）。
import type { CapabilitiesResponse, ParsedPath, PathModuleSegment } from '@cloudalbum/contracts';

export type ChipTone = 'local' | 'aws' | 'hit' | 'error' | 'bypass' | 'degraded' | 'meta';

const AWS_HOSTS = new Set(['rds', 'rds-proxy', 'elasticache', 'cloudfront', 'alb', 'apigw', 'acm']);
const AWS_DRIVERS = new Set([
  's3', 'sqs', 'lambda', 'cognito', 'sns', 'ses', 'dynamodb', 'rekognition', 'xray', 'kms', 'ssm', 'secretsmanager',
  'cloudwatch', 'firehose', 'eventbridge', 'stepfunctions', 'apigw', 'alb', 'cloudfront', 'role', 'keys', 'aws', 'efs', 'asg',
]);

export function segmentTone(seg: Pick<PathModuleSegment, 'module' | 'driver' | 'hostClass' | 'outcome'>, caps?: CapabilitiesResponse | null): ChipTone {
  const o = seg.outcome?.toLowerCase() ?? '';
  if (o === 'error-bypass' || o === 'error-basic' || o === 'error-fallback') return 'degraded';
  if (o === 'bypass' || o.endsWith('-bypass') || o.startsWith('bypass')) return 'bypass';
  if (o === 'error' || o === 'fault' || o.startsWith('error') || o.endsWith('fault')) return 'error';
  if (o === 'hit' || o === 'cache-hit') return 'hit';
  const cap = caps?.modules[seg.module];
  if (cap) return cap.status === 'off' ? 'local' : 'aws';
  if (seg.hostClass && AWS_HOSTS.has(seg.hostClass)) return 'aws';
  if (seg.driver && AWS_DRIVERS.has(seg.driver)) return 'aws';
  return 'local';
}

export function entryTone(entry: string | undefined): ChipTone {
  if (!entry) return 'meta';
  return /cloudfront|alb|waf|apigw/.test(entry) ? 'aws' : 'local';
}

export const TONE_LABEL: Record<ChipTone, string> = {
  local: '本地实现', aws: 'AWS 服务', hit: '缓存命中', error: '错误', bypass: '管理员旁路', degraded: '降级兜底', meta: '',
};

export function PathChips({ path, caps, showMeta = true }: { path: ParsedPath; caps?: CapabilitiesResponse | null; showMeta?: boolean }) {
  const hasAny = path.entry || path.modules.length || path.bypass.length;
  if (!hasAny) return <span className="subtle">（无路径头）</span>;
  return (
    <span className="chips" aria-label="请求路径">
      {showMeta && path.entry && (
        <span className={`chip chip-${entryTone(path.entry)}`} title="入口链（Nginx 计算的 $ca_entry）">
          entry={path.entry.replace(/>/g, '→')}
        </span>
      )}
      {path.modules.map((m) => {
        const tone = segmentTone(m, caps);
        return (
          <span key={m.module} className={`chip chip-${tone}`} title={`${m.module} · ${TONE_LABEL[tone]}`} data-tone={tone}>
            {m.module}={m.raw}
          </span>
        );
      })}
      {path.bypass.length > 0 && <span className="chip chip-bypass" title="管理员旁路">bypass={path.bypass.join(',')}</span>}
      {showMeta && path.inst && <span className="chip chip-meta" title="实例">{path.inst}</span>}
      {showMeta && path.az && <span className="chip chip-meta" title="可用区">{path.az}</span>}
      {path.more ? <span className="chip chip-meta" title="路径头超过 512 字节被截断">+{path.more}</span> : null}
    </span>
  );
}
