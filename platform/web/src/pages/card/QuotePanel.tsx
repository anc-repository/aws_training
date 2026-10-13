/**
 * QuotePanel：报价明细（08 §5.2；P03-D 费用段落）。桌面三列表格（`<table>`，金额右对齐、等宽数字、全部带 ≈）；
 * 窄屏由 CSS 改为纵向列表（标签一行、说明一行、金额右对齐单独一行，08 §8.8 P03）。
 * 金额全部来自服务端报价；单价暂不可得的行显示“未知”，缺字段的行显示“未提供”（08 §9.2 #6 回写前）。
 */
import { lineText, quoteRows, amountText, type QuoteRowsOptions } from './startModel';
import { BILLING_TEXT } from '../../ui';
import { SS } from './strings';
import type { CostQuote } from '../labs/types';

export function QuotePanel({ quote, options }: { quote: CostQuote; options: QuoteRowsOptions }) {
  const rows = quoteRows(quote, options);
  const cur = quote.currency ?? 'USD';
  // 服务端说明中提到内部组件名的句子不进界面（08 §1.6“实现细节不进文案”）；单价不可得由对话框统一说明
  const notes = (quote.notes ?? []).filter((n) => !/atl-[a-z]/.test(n));
  return (
    <div className="stack-8" data-quote={quote.quoteId}>
      {quote.pricing === 'fixture' ? (
        <p className="note blue" role="note" data-pricing="fixture">
          {SS.quote.fixture}
        </p>
      ) : null}
      <div className="tbl-wrap">
        <table className="tbl qtbl">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-row={r.key}>
                <th scope="row">{r.label}</th>
                <td className="qdesc">{r.desc}</td>
                <td className="qamt">
                  {r.amount.kind === 'range' ? <span className="amt">{amountText(r.amount, cur)}</span> : <span className="unknown">{r.amount.text}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="disc small">
        <summary>{SS.dialog.dimensions}</summary>
        <ul>
          {(quote.lines ?? []).map((l, i) => (
            <li key={i}>
              {lineText(l)}
              {l.billing ? ` · ${(BILLING_TEXT as Record<string, string>)[l.billing] ?? l.billing}` : ''}
              {l.optional ? '（选做）' : ''}
              {l.unknown ? SS.quote.unknownMark : ''}
            </li>
          ))}
        </ul>
      </details>
      {notes.length ? (
        <ul className="small muted">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      <p className="small muted">{SS.dialog.freeTier}</p>
    </div>
  );
}
