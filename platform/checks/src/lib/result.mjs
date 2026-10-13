// Result lines (04 §6.5): one `ATL-RESULT-V1 <base64url(JSON)>` line per item; JSON ≤ 16 KB, otherwise the largest
// array inside `observed` is truncated repeatedly and `truncated: true` is set.
export const RESULT_PREFIX = 'ATL-RESULT-V1 ';
export const MAX_LINE_JSON = 16 * 1024;

export function nowIso() {
  return new Date().toISOString();
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Find the largest array (by JSON length) inside a value; returns [parent, key] or null. */
function largestArray(v) {
  let best = null;
  let bestLen = 0;
  const walk = (x) => {
    if (Array.isArray(x)) {
      x.forEach((y, i) => {
        if (Array.isArray(y) && y.length > 0) {
          const l = JSON.stringify(y).length;
          if (l > bestLen) {
            best = [x, i];
            bestLen = l;
          }
        }
        walk(y);
      });
    } else if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) {
        if (Array.isArray(y) && y.length > 0) {
          const l = JSON.stringify(y).length;
          if (l > bestLen) {
            best = [x, k];
            bestLen = l;
          }
        }
        walk(y);
      }
    }
  };
  walk(v);
  return best;
}

/** Shrink `result.observed` until the JSON fits; strings longer than 2 KB are cut first. */
export function fitResult(result) {
  const r = { schema: 'atl.runcheck.result/v1', ...result, truncated: result.truncated ?? false };
  let json = JSON.stringify(r);
  if (json.length <= MAX_LINE_JSON) return r;
  r.truncated = true;
  const cutStrings = (x) => {
    if (Array.isArray(x)) return x.map(cutStrings);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, cutStrings(y)]));
    if (typeof x === 'string' && x.length > 2048) return `${x.slice(0, 2045)}…`;
    return x;
  };
  r.observed = cutStrings(r.observed);
  json = JSON.stringify(r);
  for (let guard = 0; json.length > MAX_LINE_JSON && guard < 200; guard++) {
    const hit = largestArray(r.observed);
    if (!hit) break;
    const [parent, key] = hit;
    const arr = parent[key];
    parent[key] = arr.slice(0, Math.max(0, Math.floor(arr.length / 2)));
    json = JSON.stringify(r);
  }
  if (json.length > MAX_LINE_JSON) r.observed = { truncated: true };
  return r;
}

export function encodeResultLine(result) {
  return `${RESULT_PREFIX}${b64url(JSON.stringify(fitResult(result)))}`;
}

export function emitResult(out, result) {
  out.write(`${encodeResultLine(result)}\n`);
}
