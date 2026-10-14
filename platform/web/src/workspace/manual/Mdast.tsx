/**
 * 手册 AST 渲染器（04 §4.3、§4.5；08 P05.3）：构建期编译好的 mdast（`atl.mdast/v1`）逐节点渲染为 React 元素，
 * **不使用** dangerouslySetInnerHTML；不允许原始 HTML（构建期已拒绝，这里遇到 html 节点只显示为文本）。
 *
 * 指令：`:::why` 折叠、`:::tip|warning|danger` 提示、`:::method` 做法标签页（同一层相邻的一组）、`:::expected` 预期结果、
 * `:::wait` 等待说明、`:::reveal` 折叠提示、`:::saa` 考点、`:::code-ref` 代码片段、`::checks` / `::check` 本步检测、
 * `::console-link` 控制台深链、`::open-tab` 切换右侧标签、`::var-input` 变量输入、`::platform-action` 平台动作、`::experiment` 实验卡片、
 * 行内 `:kbd` 键帽、`:term` 术语。代码块按 `runsOn` 给出复制与“粘贴到终端”（03 §7.1）。
 *
 * 视觉化（09 I6 e）：做法标签带步骤类型图标；`:::expected` 带靶心图标，其中的示例输出高亮响应头等“名称: 值”（ExpectedOutput）；
 * `:::wait` 先给出“通常约 n 分钟”的图标行；超过 3 行的段落默认折叠（Clamp；已经在折叠块 why / reveal / saa / 概览里的不再折叠）。
 */
import { Fragment, useId, useState, type ReactNode } from 'react';
import { lsGet, lsSet } from '../../lib/storage';
import { Icon, Shape } from '../../ui';
import { StepTypeIcon } from '../../ui/charts';
import type { LabDoc, LabStep, MdNode } from '../model/lab';
import { resolveTemplate, type VarsResponse } from '../model/vars';
import { Clamp, CLAMP_MIN_CHARS } from '../visual/Clamp';
import { ExpectedOutput } from '../visual/ExpectedOutput';
import { WsIcon } from '../visual/icons';
import { codeAttrs, ManualCommand } from './ManualCommand';

import { msg, t } from '../../i18n';
import { W } from '../strings';
export interface RenderEnv {
  lab: LabDoc;
  step: LabStep | null;
  vars: VarsResponse | null;
  /** `::checks` / `::check` 的渲染（由步骤卡提供）。 */
  renderChecks?: (checkId?: string) => ReactNode;
  renderExperiment?: (attrs: { module: string; id: string; label?: string }) => ReactNode;
  renderPlatformAction?: (id: string) => ReactNode;
  renderVarInput?: (name: string) => ReactNode;
  onConsoleLink?: (linkId: string, params: Record<string, string>) => void;
  onOpenTab?: (tab: string) => void;
  /** 代码块的序号（PasteMeta.blockIndex）。 */
  blockIndex: WeakMap<MdNode, number>;
  /** 已经在折叠块（why / reveal / saa / 概览）里：段落不再折叠。 */
  inFold?: boolean;
  /** 在 `:::expected` 里：没有 runsOn 的代码块显示为高亮的示例输出。 */
  inExpected?: boolean;
}

const WD = W.md;
const METHOD_TEXT: Readonly<Record<string, string>> = WD.method;
const SAA_DOMAIN: Readonly<Record<string, string>> = WD.domain;
export const METHOD_PREF_KEY = 'atl.ws.method.v1';

function attr(n: MdNode, k: string): string | undefined {
  const v = n.attributes?.[k];
  return v === undefined || v === null || v === false ? undefined : String(v);
}

/** 为代码块编号（深度优先，与手册中的出现顺序一致）。 */
export function indexCodeBlocks(root: MdNode | null | undefined): WeakMap<MdNode, number> {
  const map = new WeakMap<MdNode, number>();
  let i = 0;
  const walk = (n: MdNode) => {
    if (n.type === 'code') map.set(n, i++);
    for (const c of n.children ?? []) walk(c);
  };
  if (root) walk(root);
  return map;
}

/** 收集手册中的全部文本（变量条用来找引用到的变量）。 */
export function collectTexts(root: MdNode | null | undefined, out: string[] = []): string[] {
  if (!root) return out;
  if (typeof root.value === 'string') out.push(root.value);
  for (const v of Object.values(root.attributes ?? {})) if (typeof v === 'string') out.push(v);
  for (const c of root.children ?? []) collectTexts(c, out);
  return out;
}

export function hasChecksDirective(root: MdNode | null | undefined): boolean {
  if (!root) return false;
  if (root.type === 'leafDirective' && (root.name === 'checks' || root.name === 'check')) return true;
  return (root.children ?? []).some(hasChecksDirective);
}

/** 行内文字：代入变量，已代入部分点状下划线（悬停显示来源），未解析部分红色虚线占位。 */
export function InlineText({ text, vars }: { text: string; vars: VarsResponse | null }) {
  const r = resolveTemplate(text, vars);
  if (r.parts.length === 1 && typeof r.parts[0] === 'string') return <>{r.parts[0]}</>;
  return (
    <>
      {r.parts.map((p, i) =>
        typeof p === 'string' ? (
          <Fragment key={i}>{p}</Fragment>
        ) : p.value ? (
          <span key={i} className="vsub" title={t(WD.fromVar, { name: p.name })}>
            {p.value}
          </span>
        ) : (
          <span key={i} className="unres" title={t(WD.unfilled, { name: p.name })}>
            {p.placeholder}
          </span>
        ),
      )}
    </>
  );
}

function MethodTabs({ groups, env }: { groups: MdNode[]; env: RenderEnv }) {
  const kinds = groups.map((g) => attr(g, 'kind') ?? 'cli');
  const pref = lsGet<string | null>(METHOD_PREF_KEY, null);
  const initial = Math.max(0, pref && kinds.includes(pref) ? kinds.indexOf(pref) : groups.findIndex((g) => g.attributes?.default === true || g.attributes?.default === ''));
  const [sel, setSel] = useState(initial < 0 ? 0 : initial);
  const ids = `mt${useId().replace(/:/g, '')}`;
  if (groups.length === 1) {
    return (
      <div className="stack-8 method" data-method={kinds[0]}>
        <span className="small muted mlabel">
          <StepTypeIcon type={kinds[0]!} />
          {t(WD.methodLabel, { m: METHOD_TEXT[kinds[0]!] ?? kinds[0] })}
        </span>
        <Nodes nodes={groups[0]!.children ?? []} env={env} />
      </div>
    );
  }
  const choose = (i: number) => {
    setSel(i);
    lsSet(METHOD_PREF_KEY, kinds[i]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = (sel + (e.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
    choose(n);
    (document.getElementById(`${ids}-t${n}`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="stack-8 method">
      <div className="mtabs-row">
        <span className="small muted">{WD.methods}</span>
        <div className="tabs mtabs" role="tablist" aria-label={WD.methods} onKeyDown={onKey}>
          {groups.map((g, i) => (
            <button
              key={i}
              id={`${ids}-t${i}`}
              type="button"
              role="tab"
              aria-selected={i === sel}
              aria-controls={`${ids}-p`}
              tabIndex={i === sel ? 0 : -1}
              onClick={() => choose(i)}
            >
              <StepTypeIcon type={kinds[i]!} />
              {METHOD_TEXT[kinds[i]!] ?? kinds[i]}
              {g.attributes?.default === true ? <span aria-hidden="true"> •</span> : null}
            </button>
          ))}
        </div>
        <select className="input mselect" aria-label={WD.methods} value={sel} onChange={(e) => choose(Number(e.target.value))}>
          {groups.map((_, i) => (
            <option key={i} value={i}>
              {METHOD_TEXT[kinds[i]!] ?? kinds[i]}
            </option>
          ))}
        </select>
      </div>
      <div id={`${ids}-p`} role="tabpanel" aria-labelledby={`${ids}-t${sel}`} className="stack-8">
        <Nodes nodes={groups[sel]!.children ?? []} env={env} />
      </div>
    </div>
  );
}

/** 一组兄弟节点：相邻的 `:::method` 合并为一个做法标签组。 */
export function Nodes({ nodes, env }: { nodes: readonly MdNode[]; env: RenderEnv }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.type === 'containerDirective' && n.name === 'method') {
      const group: MdNode[] = [n];
      while (nodes[i + 1]?.type === 'containerDirective' && nodes[i + 1]?.name === 'method') group.push(nodes[++i]!);
      out.push(<MethodTabs key={`m${i}`} groups={group} env={env} />);
      continue;
    }
    out.push(<Node key={i} node={n} env={env} />);
  }
  return <>{out}</>;
}

function Children({ node, env }: { node: MdNode; env: RenderEnv }) {
  return <Nodes nodes={node.children ?? []} env={env} />;
}

function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, globalThis.location?.origin ?? 'http://localhost');
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function Node({ node: n, env }: { node: MdNode; env: RenderEnv }): ReactNode {
  switch (n.type) {
    case 'root':
      return <Children node={n} env={env} />;
    case 'text':
      return <InlineText text={n.value ?? ''} vars={env.vars} />;
    case 'paragraph':
      if (!env.inFold && collectTexts(n).join('').length >= CLAMP_MIN_CHARS) {
        return (
          <Clamp>
            <Children node={n} env={env} />
          </Clamp>
        );
      }
      return (
        <p>
          <Children node={n} env={env} />
        </p>
      );
    case 'heading': {
      const d = Math.min(6, Math.max(3, (n.depth ?? 2) + 1));
      const H = `h${d}` as 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <H className="mh">
          <Children node={n} env={env} />
        </H>
      );
    }
    case 'inlineCode':
      return (
        <code className="ic">
          <InlineText text={n.value ?? ''} vars={env.vars} />
        </code>
      );
    case 'strong':
      return (
        <strong>
          <Children node={n} env={env} />
        </strong>
      );
    case 'emphasis':
      return (
        <em>
          <Children node={n} env={env} />
        </em>
      );
    case 'delete':
      return (
        <del>
          <Children node={n} env={env} />
        </del>
      );
    case 'break':
      return <br />;
    case 'thematicBreak':
      return <hr />;
    case 'blockquote':
      return (
        <blockquote>
          <Children node={n} env={env} />
        </blockquote>
      );
    case 'link': {
      const href = safeHref(n.url);
      if (!href) return <Children node={n} env={env} />;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          <Children node={n} env={env} />
          <span className="sr">{msg.app.newTab}</span>
        </a>
      );
    }
    case 'list': {
      const L = n.ordered ? 'ol' : 'ul';
      return (
        <L className="mlist">
          <Children node={n} env={env} />
        </L>
      );
    }
    case 'listItem':
      return (
        <li>
          {n.checked === true || n.checked === false ? <span aria-label={n.checked ? WD.done : WD.notDone}>{n.checked ? '☑ ' : '☐ '}</span> : null}
          {(n.children ?? []).length === 1 && n.children![0]!.type === 'paragraph' ? <Children node={n.children![0]!} env={env} /> : <Children node={n} env={env} />}
        </li>
      );
    case 'table':
      return (
        <div className="tbl-wrap">
          <table className="tbl mtable">
            <tbody>
              {(n.children ?? []).map((row, ri) => (
                <tr key={ri}>
                  {(row.children ?? []).map((cell, ci) =>
                    ri === 0 ? (
                      <th key={ci} scope="col">
                        <Children node={cell} env={env} />
                      </th>
                    ) : (
                      <td key={ci}>
                        <Children node={cell} env={env} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      if (env.inExpected && !codeAttrs(n).runsOn) return <ExpectedOutput text={resolveTemplate(n.value ?? '', env.vars, codeAttrs(n).vars).text} />;
      return <ManualCommand node={n} env={env} />;
    case 'html':
      return <p className="small faint">{n.value}</p>;
    case 'image':
      return null;
    case 'textDirective':
      if (n.name === 'kbd')
        return (
          <kbd>
            <Children node={n} env={env} />
          </kbd>
        );
      return (
        <span className="term-ref" title={attr(n, 'id')}>
          <Children node={n} env={env} />
        </span>
      );
    case 'containerDirective':
      return <Container node={n} env={env} />;
    case 'leafDirective':
      return <Leaf node={n} env={env} />;
    default:
      return n.children ? <Children node={n} env={env} /> : n.value ? <>{n.value}</> : null;
  }
}

function Container({ node: n, env }: { node: MdNode; env: RenderEnv }) {
  switch (n.name) {
    case 'why':
      return (
        <details className="why">
          <summary>{WD.why}</summary>
          <div className="small stack-8">
            <Children node={n} env={{ ...env, inFold: true }} />
          </div>
        </details>
      );
    case 'reveal':
      return (
        <details className="disc">
          <summary>{attr(n, 'title') ?? WD.reveal}</summary>
          <div className="small stack-8">
            <Children node={n} env={{ ...env, inFold: true }} />
          </div>
        </details>
      );
    case 'tip':
    case 'warning':
    case 'danger': {
      const cls = n.name === 'tip' ? 'note blue' : n.name === 'warning' ? 'note amber' : 'note red';
      const label = n.name === 'tip' ? WD.tip : n.name === 'warning' ? WD.warning : WD.danger;
      return (
        <div className={`${cls} mnote`} role="note">
          {n.name === 'tip' ? <Shape name="dot" /> : <Shape name="tri" />}
          <div className="stack-4">
            <b className="small">{label}</b>
            <Children node={n} env={env} />
          </div>
        </div>
      );
    }
    case 'expected':
      return (
        <div className="stack-4 expected" data-expected="">
          <b className="small exp-head">
            <WsIcon name="target" />
            {WD.expected}
          </b>
          <div className="small stack-4">
            <Children node={n} env={{ ...env, inExpected: true }} />
          </div>
        </div>
      );
    case 'wait': {
      const typical = attr(n, 'typical');
      const max = attr(n, 'max');
      return (
        <div className="note mwait" data-wait="">
          <WsIcon name="hourglass" />
          <div className="stack-4">
            <b className="small">{t(WD.waitTypical, { n: typical ?? '—', max: max ? t(WD.waitMax, { n: max }) : '' })}</b>
            <span className="small">{WD.waitAuto}</span>
            <Children node={n} env={env} />
          </div>
        </div>
      );
    }
    case 'saa': {
      const domain = attr(n, 'domain');
      return (
        <details className="disc saa">
          <summary>
            {WD.whySaa}
            {domain ? t(WD.domainTail, { d: SAA_DOMAIN[domain] ?? domain }) : ''}
            {n.attributes?.confusable ? WD.confusable : ''}
          </summary>
          <div className="small stack-8">
            <Children node={n} env={{ ...env, inFold: true }} />
          </div>
        </details>
      );
    }
    case 'code-ref':
      return (
        <div className="box stack-8 coderef">
          <span className="small mono">
            {attr(n, 'path') ?? ''}
            {attr(n, 'runsOn') ? t(WD.runsOn, { where: attr(n, 'runsOn') === 'lab' ? WD.lab : WD.workstation }) : ''}
          </span>
          <Children node={n} env={env} />
        </div>
      );
    case 'method':
      return <MethodTabs groups={[n]} env={env} />;
    default:
      return (
        <div className="stack-8">
          <Children node={n} env={env} />
        </div>
      );
  }
}

function Leaf({ node: n, env }: { node: MdNode; env: RenderEnv }) {
  switch (n.name) {
    case 'checks':
      return <>{env.renderChecks?.()}</>;
    case 'check':
      return <>{env.renderChecks?.(attr(n, 'id'))}</>;
    case 'console-link': {
      const link = attr(n, 'link');
      if (!link) return null;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.attributes ?? {})) {
        if (k === 'link' || typeof v !== 'string') continue;
        params[k] = resolveTemplate(v, env.vars).text;
      }
      const label = n.label ?? (n.children?.length ? collectTexts(n).join('') : WD.openConsole);
      return (
        <div>
          <button type="button" className="btn sm" onClick={() => env.onConsoleLink?.(link, params)} data-link={link}>
            <Icon name="ext" />
            <InlineText text={label} vars={env.vars} />
            <span className="sr">{WD.consoleNewTab}</span>
          </button>
        </div>
      );
    }
    case 'open-tab': {
      const tab = attr(n, 'tab');
      if (!tab) return null;
      const text: Readonly<Record<string, string>> = WD.tab;
      return (
        <div>
          <button type="button" className="btn sm ghost" onClick={() => env.onOpenTab?.(tab)}>
            {t(WD.switchTo, { tab: text[tab] ?? tab })}
          </button>
        </div>
      );
    }
    case 'var-input': {
      const name = attr(n, 'name');
      return name ? <>{env.renderVarInput?.(name)}</> : null;
    }
    case 'platform-action': {
      const id = attr(n, 'id');
      return id ? <>{env.renderPlatformAction?.(id)}</> : null;
    }
    case 'experiment': {
      const module = attr(n, 'module');
      const id = attr(n, 'id');
      return module && id ? <>{env.renderExperiment?.({ module, id, label: attr(n, 'label') })}</> : null;
    }
    default:
      return null;
  }
}
