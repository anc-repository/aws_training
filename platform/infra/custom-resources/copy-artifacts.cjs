// atl-copy-artifacts — CloudFormation custom resource CopyArtifacts (01 §4.5). Inline code (Code.ZipFile, minified by
// build/template-parts.ts): only Node.js 22 built-ins and the AWS SDK v3 that ships with the Lambda runtime.
// Create/Update: download every release file (GitHub Releases or s3://<ArtifactBaseUrl>), verify its SHA-256 against the
// manifest embedded in the template (ReleaseVersion=dev: against SHA256SUMS under ArtifactBaseUrl), write it to
// s3://<Bucket>/<Prefix><file>. Data: ManifestDigest, LambdasObjectVersion, WorkstationBundleSha256, ChecksBundleDigest.
// Delete: nothing (BucketEmptier empties the bucket on uninstall; old releases stay for rollback, 01 §4.7).
/* eslint-disable @typescript-eslint/no-require-imports -- inline CommonJS for Code.ZipFile (index.js) */
'use strict';
const crypto = require('node:crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Parse `SHA256SUMS` (`<hex>  <file>` lines; `# checks-bundle-digest <hex>` comment). */
function parseSums(text) {
  const files = [];
  let checks = '';
  for (const line of text.split(/\r?\n/)) {
    const c = /^#\s*checks-bundle-digest\s+([0-9a-f]{64})\s*$/.exec(line);
    if (c) checks = c[1];
    const m = /^([0-9a-f]{64}) [ *]?([A-Za-z0-9._-]+)$/.exec(line.trim());
    if (m) files.push({ Name: m[2], Sha256: m[1] });
  }
  return { Files: files, ChecksBundleDigest: checks };
}

function s3Url(url) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url || '');
  if (!m) throw new Error('BaseUrl must be s3://bucket/prefix');
  return { bucket: m[1], prefix: m[2] && !m[2].endsWith('/') ? m[2] + '/' : m[2] };
}

async function run(event, deps) {
  const p = event.ResourceProperties;
  if (event.RequestType === 'Delete') return { id: event.PhysicalResourceId, data: {} };
  const fromS3 = p.Source === 's3';
  const src = fromS3 ? s3Url(p.BaseUrl) : null;
  const get = async (name) => {
    if (fromS3) return deps.s3Get(src.bucket, src.prefix + name);
    const res = await deps.fetch(`https://github.com/${p.GitHubRepository}/releases/download/${p.ReleaseVersion}/${name}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download ${name}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  let manifest = p.Manifest || { Files: [] };
  let sums = null;
  if (p.ReleaseVersion === 'dev') {
    if (!fromS3) throw new Error('ReleaseVersion=dev requires ArtifactSource=s3');
    sums = await get('SHA256SUMS');
    manifest = parseSums(sums.toString('utf8'));
  }
  if (!manifest.Files || !manifest.Files.length) throw new Error('the template carries no release manifest (build it with build/package.ts)');
  const data = { ManifestDigest: '', LambdasObjectVersion: 'none', WorkstationBundleSha256: 'none', ChecksBundleDigest: manifest.ChecksBundleDigest || 'none' };
  const lines = [];
  for (const f of manifest.Files) {
    if (!/^[A-Za-z0-9._-]+$/.test(f.Name)) throw new Error(`bad file name ${f.Name}`);
    const body = await get(f.Name);
    const digest = sha256(body);
    if (digest !== f.Sha256) throw new Error(`SHA-256 mismatch for ${f.Name}: expected ${f.Sha256}, got ${digest}`);
    const version = await deps.s3Put(p.Bucket, p.Prefix + f.Name, body);
    if (f.Name === 'atl-lambdas.zip') data.LambdasObjectVersion = version || 'none';
    if (f.Name === 'atl-workstation.tar.gz') data.WorkstationBundleSha256 = digest;
    lines.push(`${digest}  ${f.Name}`);
  }
  const sumsText = sums || Buffer.from(lines.join('\n') + '\n');
  await deps.s3Put(p.Bucket, p.Prefix + 'SHA256SUMS', sumsText);
  data.ManifestDigest = sha256(sumsText);
  return { id: `${p.Bucket}/${p.Prefix}`, data };
}

async function respond(event, status, reason, id, data, fetchImpl) {
  const body = JSON.stringify({
    Status: status,
    Reason: String(reason).slice(0, 3500),
    PhysicalResourceId: id || event.PhysicalResourceId || event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data || {},
  });
  await fetchImpl(event.ResponseURL, { method: 'PUT', body, headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(body)) } });
}

function awsDeps() {
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  return {
    fetch,
    s3Get: async (Bucket, Key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray()),
    s3Put: async (Bucket, Key, Body) => (await s3.send(new PutObjectCommand({ Bucket, Key, Body }))).VersionId,
  };
}

exports.run = run;
exports.parseSums = parseSums;
exports.handler = async (event, _context, deps = awsDeps()) => {
  try {
    const r = await run(event, deps);
    await respond(event, 'SUCCESS', 'ok', r.id, r.data, deps.fetch);
  } catch (e) {
    console.error(e);
    await respond(event, 'FAILED', e && e.message ? e.message : String(e), event.PhysicalResourceId, {}, deps.fetch);
  }
};
