/**
 * 预期结果中的示例输出（09 I6 e“预期结果用视觉提示，例如期待看到的响应头高亮”）：`:::expected` 里没有 runsOn 的代码块
 * （示例输出、响应头）不再显示成可复制的命令块，而是一块“期待看到”的输出：
 *
 * - `name: value` 形式的行（HTTP 响应头、YAML 键；冒号后要有空格，所以 ARN、URL 不算）高亮名称、加粗值；`"key": value` 形式的 JSON 行同样；
 * - `HTTP/1.1 200 OK` 这样的状态行高亮状态码；
 * - 其他行原样显示。变量照常代入，显示经过界面打码器（与命令块一致）。
 * 高亮只是视觉提示（`<mark>`），文字内容不变；不写 style 属性。
 */
import { Fragment, type ReactNode } from 'react';
import { redact } from '../../lib/redact';

const HEADER = /^(\s*)([A-Za-z][\w.-]*)(:\s+)(.*)$/;
const JSON_KEY = /^(\s*)("[^"]+")(\s*:\s*)(.*)$/;
const STATUS = /^(\s*HTTP\/[\d.]+\s+)(\d{3})(.*)$/;

export interface OutputSegment {
  text: string;
  /** key：高亮的名称 / 状态码；value：加粗的值。 */
  kind?: 'key' | 'value';
}

/** 一行示例输出 → 片段（纯函数，测试用）。 */
export function segmentLine(line: string): OutputSegment[] {
  const s = STATUS.exec(line);
  const keep = (segs: OutputSegment[]) => segs.filter((x) => x.text !== '');
  if (s) return keep([{ text: s[1]! }, { text: s[2]!, kind: 'key' }, { text: s[3]! }]);
  const m = JSON_KEY.exec(line) ?? HEADER.exec(line);
  // URL（https://…）与 Windows 路径不是“名称: 值”
  if (m && !/^\/\//.test(m[4] ?? '') && !/^https?$/i.test(m[2]!) && m[2]!.length > 1) {
    return keep([{ text: m[1]! }, { text: m[2]!, kind: 'key' }, { text: m[3]! }, { text: m[4]!, kind: 'value' }]);
  }
  return [{ text: line }];
}

export function ExpectedOutput({ text }: { text: string }) {
  const lines = redact(text).replace(/\n+$/, '').split('\n');
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i) out.push('\n');
    out.push(
      <Fragment key={i}>
        {segmentLine(line).map((seg, j) =>
          seg.kind === 'key' ? (
            <mark key={j} className="eo-k">
              {seg.text}
            </mark>
          ) : seg.kind === 'value' ? (
            <b key={j} className="eo-v">
              {seg.text}
            </b>
          ) : (
            <Fragment key={j}>{seg.text}</Fragment>
          ),
        )}
      </Fragment>,
    );
  });
  return (
    <pre className="mono small snippet eo" data-expected-output="">
      <code>{out}</code>
    </pre>
  );
}
