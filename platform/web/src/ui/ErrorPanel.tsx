/**
 * 区块级错误面板 ErrorPanel（08 §4.0、P13）：problem+json 的 title、按 code 查到的说明、requestId（可复制）、[重试]；
 * 区块级错误不影响其他区块。未知 code 显示 title + detail + requestId（P13 #34）。
 */
import { useState } from 'react';
import { t, zhCN } from '../i18n/zh-CN';
import { copyText } from '../lib/clipboard';
import { Button } from './Button';

/** 与 api/errors.ts 的 ApiError 结构兼容的最小形状（ui 不依赖 api 层）。 */
export interface ProblemLike {
  code?: string | null;
  status?: number | null;
  title?: string | null;
  detail?: string | null;
  requestId?: string | null;
}

/** 错误码 → 学员看到的文案（画面可传 overrides 覆盖）。 */
export function problemMessage(p: ProblemLike, overrides: Record<string, string> = {}): string {
  const code = p.code ?? '';
  const tpl = overrides[code] ?? zhCN.errors[code];
  if (tpl) return t(tpl, { detail: p.detail ?? '', requestId: p.requestId ?? '—' });
  if (p.status && p.status >= 500) return t(zhCN.p13.apiUnavailable, { status: p.status });
  return [p.title, p.detail].filter(Boolean).join('：') || zhCN.errors.INTERNAL!.replace('{requestId}', p.requestId ?? '—');
}

export interface ErrorPanelProps {
  error: ProblemLike;
  onRetry?: () => void;
  overrides?: Record<string, string>;
  /** 区块标题（默认不显示）。 */
  title?: string;
}

export function ErrorPanel({ error, onRetry, overrides, title }: ErrorPanelProps) {
  const [copied, setCopied] = useState(false);
  const msg = problemMessage(error, overrides);
  const diag = JSON.stringify({ code: error.code ?? null, status: error.status ?? null, requestId: error.requestId ?? null, title: error.title ?? null });
  return (
    <div className="errpanel" role="alert" data-code={error.code ?? undefined}>
      {title ? <b>{title}</b> : null}
      <p>{msg}</p>
      {error.requestId ? (
        <span className="rid">
          {zhCN.p13.requestId} {error.requestId}
        </span>
      ) : null}
      <div className="row">
        {onRetry ? (
          <Button size="sm" onClick={onRetry} icon="refresh">
            {zhCN.app.retry}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon="copy"
          onClick={() => {
            void copyText(diag).then((ok) => setCopied(ok));
          }}
        >
          {copied ? zhCN.app.copied : zhCN.app.copyDiagnostics}
        </Button>
      </div>
    </div>
  );
}
