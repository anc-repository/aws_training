/**
 * 数据表 DataTable（08 §5.5 沿用 ui-design §8.1；原型 `.tbl`）。
 * - 表头 `scope="col"`；可排序列的按钮带 aria-sort（§8.3“表格”）；
 * - 行可聚焦，Enter 打开详情（onRowClick）；当前行高亮（currentKey）；
 * - 数字列右对齐、tabular-nums；放在自己的横向滚动容器中；`cardify` 时窄屏改为卡片（每个字段一行，标签取 data-label）。
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  /** 提供时该列可排序。 */
  sortValue?: (row: T) => string | number;
}

export type SortDir = 'ascending' | 'descending';

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption?: string;
  onRowClick?: (row: T) => void;
  currentKey?: string | null;
  cardify?: boolean;
  initialSort?: { key: string; dir: SortDir };
  /** 没有行时显示（通常是 EmptyState）。 */
  empty?: ReactNode;
}

export function DataTable<T>({ columns, rows, rowKey, caption, onRowClick, currentKey, cardify, initialSort, empty }: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const f = col.sortValue;
    const out = [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.dir === 'descending' ? out.reverse() : out;
  }, [rows, columns, sort]);

  if (!rows.length && empty) return <>{empty}</>;

  const onKey = (row: T) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (onRowClick && e.key === 'Enter') {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className={cardify ? 'tbl-wrap cardify' : 'tbl-wrap'}>
      <table className="tbl">
        {caption ? <caption className="sr">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined} aria-sort={c.sortValue ? (active ? sort!.dir : 'none') : undefined}>
                  {c.sortValue ? (
                    <button
                      type="button"
                      className="sort"
                      onClick={() => setSort({ key: c.key, dir: active && sort!.dir === 'ascending' ? 'descending' : 'ascending' })}
                    >
                      {c.header}
                      <span aria-hidden="true">{active ? (sort!.dir === 'ascending' ? '▲' : '▼') : '↕'}</span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const k = rowKey(row);
            const cls = [onRowClick ? 'click' : '', currentKey === k ? 'cur' : ''].filter(Boolean).join(' ') || undefined;
            return (
              <tr
                key={k}
                className={cls}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? onKey(row) : undefined}
                aria-current={currentKey === k ? 'true' : undefined}
                data-k={k}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? 'num' : undefined} data-label={c.header}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
