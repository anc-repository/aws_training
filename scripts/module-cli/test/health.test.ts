// health.ts：enable 第 10 步的探针判定（wave1-fix：degraded + data.transient 不算通过，继续轮询到超时）
import { describe, expect, it } from 'vitest';
import { parseProbe } from '../src/health.js';

const json = (o: unknown) => `probe output\n${JSON.stringify(o, null, 2)}`;

describe('parseProbe', () => {
  it('ok 与非瞬时的 degraded 通过；error、unknown 不通过', () => {
    expect(parseProbe(json({ status: 'ok', detail: 'fine' }))).toMatchObject({ ok: true, status: 'ok' });
    expect(parseProbe(json({ status: 'degraded', detail: '沙盒', data: { identity: 'a' } }))).toMatchObject({ ok: true, status: 'degraded' });
    expect(parseProbe(json({ status: 'error', detail: 'AccessDenied' }))).toMatchObject({ ok: false, status: 'error' });
    expect(parseProbe('not json')).toMatchObject({ ok: false, status: 'unknown' });
  });

  it('degraded + data.transient=true（控制面连不上：超时、ENOTFOUND、凭证暂时取不到）不通过，并标出 transient', () => {
    const r = parseProbe(json({ status: 'degraded', detail: 'SES 控制面暂时不可达（将重试）：ENOTFOUND', data: { transient: true } }));
    expect(r).toMatchObject({ ok: false, status: 'degraded', transient: true });
  });
});
