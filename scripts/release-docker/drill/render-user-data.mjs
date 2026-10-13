#!/usr/bin/env node
// scripts/release-docker/drill/render-user-data.mjs — render the L0 User Data stub exactly as CloudFormation would:
// the `Fn::Base64: !Sub |` block of InstanceA in infra/modules/ec2.yaml with every ${…} replaced (00-ec2-base 6.5).
//   node render-user-data.mjs <ec2.yaml> <out.sh> Key=Value … (keys: Env, AWS::Region, AppArchiveUrl, AppArchiveSha256,
//                                                              Eip, AdminEmail, PlatformMode, AWS::StackName)
// Fails when a ${…} reference is left without a value, so a new stack parameter in the stub cannot slip past the drill.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function extractUserData(yamlText, resource = 'InstanceA') {
  const lines = yamlText.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l === `  ${resource}:`);
  if (start < 0) throw new Error(`resource ${resource} not found`);
  let i = lines.findIndex((l, k) => k > start && /^\s+Fn::Base64: !Sub \|\s*$/.test(l));
  if (i < 0) throw new Error(`${resource} has no Fn::Base64: !Sub | user data`);
  const body = [];
  let indent = null;
  for (i += 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.length - l.trimStart().length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n') + '\n';
}

export function substitute(text, values) {
  const missing = new Set();
  const out = text.replace(/\$\{([^}!]+)\}/g, (m, key) => {
    if (Object.hasOwn(values, key)) return values[key];
    missing.add(key);
    return m;
  });
  if (missing.size) throw new Error(`no value for ${[...missing].join(', ')}`);
  return out.replace(/\$\{!([^}]+)\}/g, '${$1}'); // Fn::Sub escape ${!Literal}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [yamlFile, outFile, ...pairs] = process.argv.slice(2);
  const values = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  fs.writeFileSync(outFile, substitute(extractUserData(fs.readFileSync(yamlFile, 'utf8')), values), { mode: 0o755 });
  console.log(`user data → ${outFile}`);
}
