/**
 * MarkdownView：渲染作者撰写的概览 `00-overview.md` 编译后的 mdast（04 §4.5，`atl.mdast/v1`；08 P03 组件 MarkdownView）。
 * 只渲染已知节点类型（不使用 dangerouslySetInnerHTML）；`:::why` 渲染为默认折叠的“原理”；链接只允许站内与
 * docs.aws.amazon.com / aws.amazon.com（05 §7.2 写作规则），外链新标签页打开并带“（新标签页）”。
 */
import { Fragment, type ReactNode } from 'react';
import { zhCN } from '../../i18n/zh-CN';
import { SECTION_TEXT } from '../labs/strings';
import type { MdNode } from '../labs/types';

const ALLOWED_HOSTS = /^(?:[a-z0-9-]+\.)*(?:docs\.aws\.amazon\.com|aws\.amazon\.com)$/i;

export function safeHref(url: string | undefined): { href: string; external: boolean } | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return { href: url, external: false };
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && ALLOWED_HOSTS.test(u.hostname)) return { href: u.toString(), external: true };
  } catch {
    return null;
  }
  return null;
}

/** 节点的纯文本（标题匹配、读屏名称）。 */
export function textOf(n: MdNode | undefined | null): string {
  if (!n) return '';
  if (typeof n.value === 'string') return n.value;
  return (n.children ?? []).map(textOf).join('');
}

function kids(n: MdNode, keyBase: string): ReactNode {
  return (n.children ?? []).map((c, i) => <MdNodeView key={`${keyBase}.${i}`} node={c} k={`${keyBase}.${i}`} />);
}

function MdNodeView({ node: n, k }: { node: MdNode; k: string }): ReactNode {
  switch (n.type) {
    case 'root':
      return <>{kids(n, k)}</>;
    case 'text':
      return n.value ?? '';
    case 'paragraph':
      return <p>{kids(n, k)}</p>;
    case 'heading': {
      const d = Math.min(6, Math.max(3, (n.depth ?? 2) + 1));
      const H = `h${d}` as 'h3';
      return <H>{kids(n, k)}</H>;
    }
    case 'strong':
      return <strong>{kids(n, k)}</strong>;
    case 'emphasis':
      return <em>{kids(n, k)}</em>;
    case 'delete':
      return <del>{kids(n, k)}</del>;
    case 'inlineCode':
      return <code>{n.value}</code>;
    case 'code':
      return (
        <pre>
          <code>{n.value}</code>
        </pre>
      );
    case 'break':
      return <br />;
    case 'thematicBreak':
      return <hr className="rule" />;
    case 'blockquote':
      return <blockquote>{kids(n, k)}</blockquote>;
    case 'list':
      return n.ordered ? <ol>{kids(n, k)}</ol> : <ul>{kids(n, k)}</ul>;
    case 'listItem':
      return <li>{kids(n, k)}</li>;
    case 'link': {
      const h = safeHref(n.url);
      if (!h) return <>{kids(n, k)}</>;
      return h.external ? (
        <a href={h.href} target="_blank" rel="noopener noreferrer">
          {kids(n, k)}
          <span className="sr">{zhCN.app.newTab}</span> ↗
        </a>
      ) : (
        <a href={h.href}>{kids(n, k)}</a>
      );
    }
    case 'table':
      return (
        <div className="tbl-wrap">
          <table className="tbl">
            <tbody>{kids(n, k)}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr>{kids(n, k)}</tr>;
    case 'tableCell':
      return <td>{kids(n, k)}</td>;
    case 'containerDirective':
      if (n.name === 'why')
        return (
          <details className="why">
            <summary>{SECTION_TEXT.why}</summary>
            {kids(n, k)}
          </details>
        );
      return <div>{kids(n, k)}</div>;
    case 'html':
      return null;
    default:
      return n.children ? <Fragment>{kids(n, k)}</Fragment> : (n.value ?? null);
  }
}

export function MarkdownView({ nodes }: { nodes: readonly MdNode[] }) {
  return (
    <div className="md">
      {nodes.map((n, i) => (
        <MdNodeView key={i} node={n} k={String(i)} />
      ))}
    </div>
  );
}

/** 按二级标题切分概览：`## 背景`、`## 为什么组合在一起`、`## 对比实验预告`、`## 平台模式说明`（05 §7.2）。 */
export function splitOverview(root: MdNode | null | undefined): { title: string; nodes: MdNode[] }[] {
  const out: { title: string; nodes: MdNode[] }[] = [];
  let cur: { title: string; nodes: MdNode[] } | null = null;
  for (const n of root?.children ?? []) {
    if (n.type === 'heading' && n.depth === 2) {
      cur = { title: textOf(n).trim(), nodes: [] };
      out.push(cur);
    } else {
      if (!cur) {
        cur = { title: '', nodes: [] };
        out.push(cur);
      }
      cur.nodes.push(n);
    }
  }
  return out;
}
