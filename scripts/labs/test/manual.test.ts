import { describe, expect, it } from 'vitest';
import { parseAttrs, parseManual, parseVariable } from '../src/manual.js';

const SAMPLE = `---
step: enable
---

Intro with {{ var.queueUrl }} and a [link](https://docs.aws.amazon.com/sqs/).

:::method{kind=script default}
\`\`\`bash {runsOn=workstation}
scripts/module enable queue --dry-run
\`\`\`
:::

::::why
outer
:::tip
inner with \`code\`
:::
::::

::console-link[打开队列]{link=sqs.queue queueUrlEncoded="{{ var.queueUrl | url }}"}

\`\`\`bash {runsOn=lab vars=false}
echo "{{ not.a.variable }}"
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

::checks
`;

describe('manual parser (atl.mdast/v1)', () => {
  it('parses front matter, directives, code fences, variables and links', () => {
    const m = parseManual(SAMPLE, 'manual/30-enable.md');
    expect(m.errors).toEqual([]);
    expect(m.frontMatter).toEqual({ step: 'enable' });
    expect(m.ast.schema).toBe('atl.mdast/v1');
    const names = m.directives.map((d) => `${d.kind}:${d.name}`);
    expect(names).toEqual(expect.arrayContaining(['container:method', 'container:why', 'container:tip', 'leaf:console-link', 'leaf:checks']));
    const method = m.directives.find((d) => d.name === 'method')!;
    expect(method.attributes).toMatchObject({ kind: 'script', default: true });
    const link = m.directives.find((d) => d.name === 'console-link')!;
    expect(link.label).toBe('打开队列');
    expect(link.attributes).toMatchObject({ link: 'sqs.queue', queueUrlEncoded: '{{ var.queueUrl | url }}' });
    expect(m.code.map((c) => c.attributes.runsOn)).toEqual(['workstation', 'lab']);
    expect(m.code[0]!.value).toContain('--dry-run');
    const exprs = m.variables.map((v) => v.expr.trim());
    expect(exprs).toContain('var.queueUrl');
    expect(exprs).toContain('var.queueUrl | url');
    expect(exprs.some((e) => e.startsWith('not.a'))).toBe(false); // vars=false code block
    expect(m.links.map((l) => l.url)).toContain('https://docs.aws.amazon.com/sqs/');
  });

  it('reports an unclosed container', () => {
    const m = parseManual('---\nstep: x\n---\n\n:::why\nnever closed\n', 'manual/x.md');
    expect(m.errors.length).toBeGreaterThan(0);
  });

  it('parses attributes with quotes, flags and spaces', () => {
    expect(parseAttrs('{kind=cli default typical=3 label="a b" x=\'c d\'}')).toEqual({ kind: 'cli', default: true, typical: '3', label: 'a b', x: 'c d' });
  });

  it('parses variable references with filters', () => {
    expect(parseVariable('var.queueUrl | url')).toMatchObject({ ns: 'var', path: ['queueUrl'] });
    expect(parseVariable('session.region')).toMatchObject({ ns: 'session', path: ['region'] });
    expect(parseVariable('???')).toBeNull();
  });
});
