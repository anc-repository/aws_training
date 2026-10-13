/**
 * WebDeploy (01 §4.6, §4.7 #4): publishes the SPA (atl-web.zip), config.json, the content release (atl-content.zip →
 * content/<catalogVersion>/, quiz bank → atl-artifacts releases/<ver>/private/) and the CloudShell kit
 * (atl-cloudshell-kit-*.tar.gz → kit/cloudshell/<ver>/) into atl-web, records the CatalogRelease, and invalidates the entry
 * documents. It never deletes anything and never writes under verify/ state that atl-certs owns: .well-known/, public/,
 * share/ (01 §3.7). Missing optional archives are skipped (logged), so a source deployment without a built SPA still works.
 */
import { createHash } from 'node:crypto';
import { Keys } from '@atl/shared';
import type { CfnEvent, CfnResult } from '../cfn.js';
import { defaultPhysicalId, optProp, prop } from '../cfn.js';
import type { Ports } from '../ports.js';
import { readZip, type ZipEntry } from '../zip.js';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  env: 'text/plain; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  jws: 'application/jose',
  gz: 'application/gzip',
};

export function contentType(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** Entry documents must always be revalidated (01 §3.8); hashed assets are immutable. */
export function cacheControl(key: string): string {
  if (/(^|\/)index\.html$/.test(key) || key === 'config.json') return 'no-cache';
  if (key.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=300';
}

/** Prefixes WebDeploy must never write (owned by atl-certs or published separately). */
export const PROTECTED_WEB_PREFIXES = ['.well-known/', 'public/', 'share/', 'content/', 'kit/'] as const;

export interface ContentManifest {
  catalogVersion: string;
  registryVersion?: string;
  toolkitVersion?: string;
  taxonomyVersion?: string;
}

export function splitContent(entries: ZipEntry[]): { catalog: ContentManifest; web: ZipEntry[]; privateFiles: ZipEntry[]; digest: string } {
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('atl-content.zip has no manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as ContentManifest;
  if (!manifest.catalogVersion || !/^[A-Za-z0-9._-]+$/.test(manifest.catalogVersion)) throw new Error('content manifest.json needs a catalogVersion');
  const web: ZipEntry[] = [];
  const privateFiles: ZipEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith('private/')) privateFiles.push(e);
    else web.push({ ...e, name: `content/${manifest.catalogVersion}/${e.name}` });
  }
  return { catalog: manifest, web, privateFiles, digest: createHash('sha256').update(manifestEntry.data).digest('hex') };
}

export async function webDeploy(event: CfnEvent, ports: Ports): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  if (event.RequestType === 'Delete') return { physicalResourceId: id };
  const artifacts = prop(event, 'ArtifactsBucket');
  const prefix = prop(event, 'ReleasePrefix');
  const web = prop(event, 'WebBucket');
  const table = prop(event, 'Table');
  const version = optProp(event, 'Version');
  const config = event.ResourceProperties.Config;
  if (!config || typeof config !== 'object') throw new Error('WebDeploy: Config is required');
  const data: Record<string, string> = { Spa: 'skipped', Content: 'skipped', CloudShellKit: 'skipped' };

  const spa = await ports.s3.getObject(artifacts, `${prefix}atl-web.zip`);
  if (spa) {
    let n = 0;
    for (const e of readZip(spa)) {
      if (e.name === 'config.json' || PROTECTED_WEB_PREFIXES.some((p) => e.name.startsWith(p))) continue;
      await ports.s3.putObject(web, e.name, e.data, { contentType: contentType(e.name), cacheControl: cacheControl(e.name) });
      n++;
    }
    data.Spa = String(n);
  } else ports.log('atl-web.zip not in the release; SPA not published');

  await ports.s3.putObject(web, 'config.json', JSON.stringify(config, null, 2) + '\n', { contentType: 'application/json', cacheControl: 'no-cache' });

  const content = await ports.s3.getObject(artifacts, `${prefix}atl-content.zip`);
  if (content) {
    const { catalog, web: files, privateFiles, digest } = splitContent(readZip(content));
    for (const e of files) await ports.s3.putObject(web, e.name, e.data, { contentType: contentType(e.name), cacheControl: 'public, max-age=31536000, immutable' });
    for (const e of privateFiles) await ports.s3.putObject(artifacts, `${prefix}${e.name}`, e.data, { contentType: contentType(e.name) });
    const now = ports.now().toISOString();
    await ports.table.put(table, {
      ...Keys.catalogRelease(catalog.catalogVersion),
      type: 'CatalogRelease',
      ver: 1,
      createdAt: now,
      updatedAt: now,
      catalogVersion: catalog.catalogVersion,
      contentDigest: digest,
      publishedAt: now,
      registryVersion: catalog.registryVersion ?? null,
      toolkitVersion: catalog.toolkitVersion ?? null,
      taxonomyVersion: catalog.taxonomyVersion ?? null,
      platformVersion: version,
      defective: false,
    });
    await ports.table.put(table, { ...Keys.catalogCurrent(), type: 'CatalogRelease', ver: 1, createdAt: now, updatedAt: now, catalogVersion: catalog.catalogVersion });
    data.Content = catalog.catalogVersion;
  } else ports.log('atl-content.zip not in the release; content not published');

  const kits = (await ports.s3.listKeys(artifacts, prefix)).filter((k) => /\/atl-cloudshell-kit-[a-z0-9_]+\.tar\.gz$/.test(k));
  for (const k of kits) {
    const body = await ports.s3.getObject(artifacts, k);
    if (body) await ports.s3.putObject(web, `kit/cloudshell/${version}/${k.slice(k.lastIndexOf('/') + 1)}`, body, { contentType: 'application/gzip', cacheControl: 'public, max-age=31536000, immutable' });
  }
  if (kits.length) data.CloudShellKit = String(kits.length);

  const dist = optProp(event, 'DistributionId');
  if (dist) await ports.cdn.invalidate(dist, ['/index.html', '/config.json', '/verify/index.html']);
  return { physicalResourceId: id, data };
}
