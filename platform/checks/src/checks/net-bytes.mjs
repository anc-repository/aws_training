// net-bytes (04 §6.4): rx/tx byte counters of the non-loopback interfaces from /proc/net/dev, sampled twice when a
// short window (≤ 10 s) is given, otherwise the cumulative counters.
import fs from 'node:fs';
import { parseDuration } from './nginx-log-summary.mjs';

function read() {
  let text;
  try {
    text = fs.readFileSync('/proc/net/dev', 'utf8');
  } catch {
    return null;
  }
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    rx += cols[0] ?? 0;
    tx += cols[8] ?? 0;
  }
  return { rx, tx };
}

export default async function netBytes(args) {
  const a = read();
  if (!a) return { available: false, rxBytes: null, txBytes: null };
  const ms = parseDuration(args.window ?? '0s') ?? 0;
  if (ms > 0 && ms <= 10_000) {
    await new Promise((r) => setTimeout(r, ms));
    const b = read();
    return { available: true, sampledMs: ms, rxBytes: b.rx - a.rx, txBytes: b.tx - a.tx };
  }
  return { available: true, cumulative: true, rxBytes: a.rx, txBytes: a.tx };
}
