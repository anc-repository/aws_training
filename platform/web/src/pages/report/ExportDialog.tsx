/**
 * 导出报告（08 P08“导出对话框”；04 §9.4）。`GET /sessions/{sid}/report/export?format=json|html&mask=on|off`：
 * 已渲染过的副本直接给预签名链接（200 ready），否则 202 rendering，按 retryAfterSeconds 重试同一请求，拿到链接为止（最多 5 分钟）。
 * 下载以导航方式进行（不经 fetch）：就绪后给出一个新标签页链接（由学员点击，不会被弹窗拦截）。
 * 关闭“账号 ID 打码”需要再次确认。平台目前只支持账号 ID 与公网 IP 同时打码或同时不打码（mask=on|off）。
 */
import { useEffect, useRef, useState } from 'react';
import { isApiError, type ApiError } from '../../api/errors';
import { useServices } from '../../app/context';
import { announce } from '../../lib/announce';
import { Button, Dialog, Icon, Shape } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';

interface ExportResult {
  status?: 'ready' | 'rendering';
  retryAfterSeconds?: number;
  download?: { url: string; expiresAt?: string } | null;
  version?: number | null;
}

export const EXPORT_TIMEOUT_MS = 5 * 60_000;

export function ExportDialog({ sid, onClose }: { sid: string; onClose: () => void }) {
  const { api } = useServices();
  const [format, setFormat] = useState<'html' | 'json'>('html');
  const [acct, setAcct] = useState(true);
  const [ip, setIp] = useState(true);
  const [confirmUnmask, setConfirmUnmask] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'rendering' | 'ready' | 'timeout'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const mixed = acct !== ip;
  const blockedReason = mixed ? '平台目前只能同时打码或同时不打码账号 ID 与公网 IP' : !acct && !confirmUnmask ? '请先确认导出文件会包含完整的 AWS 账号 ID' : null;

  const request = async () => {
    try {
      const r = await api.call<ExportResult>('exportReport', { params: { sid }, query: { format, mask: acct ? 'on' : 'off' }, conditional: false });
      const d = r.data;
      if (d?.status === 'ready' && d.download?.url) {
        setUrl(d.download.url);
        setPhase('ready');
        announce('导出文件已就绪');
        return;
      }
      if (Date.now() - started.current > EXPORT_TIMEOUT_MS) {
        setPhase('timeout');
        return;
      }
      setPhase('rendering');
      timer.current = setTimeout(() => void request(), Math.max(2, d?.retryAfterSeconds ?? 10) * 1000);
    } catch (e) {
      if (!isApiError(e)) throw e;
      setError(e);
      setPhase('idle');
    }
  };
  const start = () => {
    setError(null);
    setUrl(null);
    started.current = Date.now();
    setPhase('rendering');
    void request();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="导出报告"
      size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {phase === 'ready' ? '关闭' : '取消'}
          </button>
          {phase !== 'ready' ? (
            <Button variant="primary" busy={phase === 'rendering'} busyText="正在生成…" disabledReason={blockedReason} onClick={start}>
              导出
            </Button>
          ) : null}
        </>
      }
    >
      <fieldset className="stack-4 plain-fieldset">
        <legend className="flabel">格式</legend>
        <div className="radio-row" role="radiogroup" aria-label="格式">
          <label>
            <input type="radio" name="ex-format" value="html" checked={format === 'html'} onChange={() => setFormat('html')} />
            HTML（单文件，可离线打开、可打印为 PDF）
          </label>
          <label>
            <input type="radio" name="ex-format" value="json" checked={format === 'json'} onChange={() => setFormat('json')} />
            JSON（权威格式）
          </label>
        </div>
      </fieldset>
      <label className="chk">
        <input type="checkbox" checked={acct} onChange={(e) => setAcct(e.target.checked)} />
        <span>账号 ID 打码</span>
      </label>
      {!acct ? (
        <label className="chk">
          <input type="checkbox" checked={confirmUnmask} onChange={(e) => setConfirmUnmask(e.target.checked)} />
          <span>我确认导出文件会包含完整的 AWS 账号 ID</span>
        </label>
      ) : null}
      <label className="chk">
        <input type="checkbox" checked={ip} onChange={(e) => setIp(e.target.checked)} />
        <span>公网 IP 打码</span>
      </label>
      {mixed ? <p className="small st drift">平台目前只能同时打码或同时不打码账号 ID 与公网 IP。</p> : null}
      <p className="small muted">导出的报告包含手动确认备注与完整检查记录。PDF：在浏览器中打开 HTML 报告后，选择 打印 › 另存为 PDF。</p>
      <div className="note">
        <Icon name="shield" />
        <span>打码导出的文件与证书引用的报告不是同一份字节，不能用于证书核对；核对用的报告 JSON 请在证书详情中下载。</span>
      </div>
      {phase === 'rendering' ? (
        <p className="row small" role="status">
          <Shape name="spin" spin /> 正在生成导出文件（通常几十秒），可以留在这里等待。
        </p>
      ) : null}
      {phase === 'timeout' ? <p className="small st drift">导出文件还没有生成完，请稍后再试。</p> : null}
      {phase === 'ready' && url ? (
        <p className="row" role="status">
          <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer" data-export-link="">
            <Icon name="down" />
            下载 {format.toUpperCase()}
            <span className="sr">（新标签页）</span>
          </a>
          <span className="small muted">链接 15 分钟内有效。</span>
        </p>
      ) : null}
      {error ? <InlineProblem error={error} onRetry={start} /> : null}
    </Dialog>
  );
}
