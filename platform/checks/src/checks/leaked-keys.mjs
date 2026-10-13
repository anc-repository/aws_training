// leaked-keys (04 §6.4): long-term access keys left on the instance. Counts and places only; values are never returned.
import fs from 'node:fs';
import path from 'node:path';

const KEY_RE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;

function candidates(ctx) {
  const files = ['/root/.aws/credentials', '/root/.aws/config', '/etc/environment'];
  try {
    for (const u of fs.readdirSync('/home')) files.push(path.join('/home', u, '.aws', 'credentials'), path.join('/home', u, '.bash_history'));
  } catch {
    /* no /home */
  }
  const etc = ctx.paths.etc;
  try {
    for (const f of fs.readdirSync(etc)) if (f.endsWith('.env')) files.push(path.join(etc, f));
    for (const f of fs.readdirSync(ctx.paths.modulesDir)) if (f.endsWith('.env')) files.push(path.join(ctx.paths.modulesDir, f));
  } catch {
    /* missing config dir */
  }
  return files;
}

export default async function leakedKeys(_args, ctx) {
  const places = [];
  let count = 0;
  for (const f of candidates(ctx)) {
    let text;
    try {
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const n = (text.match(KEY_RE) ?? []).filter((k) => k.startsWith('AKIA')).length;
    if (n > 0) {
      count += n;
      places.push({ file: ctx.dev ? path.basename(f) : f, count: n });
    }
  }
  return { count, places };
}
