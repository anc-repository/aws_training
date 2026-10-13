// Platform-mode template requirements (docs/platform/06 PM-05, PM-24, PM-29, PM-31): template unit tests (cfn-lint runs separately)
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTemplate, type CfnTemplate } from '../src/template.js';
import { REPO_ROOT } from './helpers.js';

const load = (f: string): CfnTemplate => loadTemplate(REPO_ROOT, `infra/modules/${f}`);
const TEMPLATES = readdirSync(path.join(REPO_ROOT, 'infra', 'modules')).filter((f) => f.endsWith('.yaml'));

type Behavior = { PathPattern?: string; TargetOriginId?: unknown; CachePolicyId?: unknown; OriginRequestPolicyId?: unknown };

describe('cdn: experiment headers reach the EC2 / ALB origin (PM-24, both modes)', () => {
  const t = load('cdn.yaml');
  const dist = t.Resources.Distribution!.Properties!.DistributionConfig as { DefaultCacheBehavior: Behavior; CacheBehaviors: Behavior[] };

  it('a customer managed origin request policy forwards exactly X-Experiment-Run, X-Experiment-Label, X-ATL-Probe-Nonce', () => {
    const p = t.Resources.ExperimentOriginRequestPolicy!;
    expect(p.Type).toBe('AWS::CloudFront::OriginRequestPolicy');
    const cfg = p.Properties!.OriginRequestPolicyConfig as { HeadersConfig: { HeaderBehavior: string; Headers: string[] }; CookiesConfig: unknown; QueryStringsConfig: unknown };
    expect(cfg.HeadersConfig).toEqual({ HeaderBehavior: 'whitelist', Headers: ['X-Experiment-Run', 'X-Experiment-Label', 'X-ATL-Probe-Nonce'] });
    expect(cfg.CookiesConfig).toEqual({ CookieBehavior: 'none' });
    expect(JSON.stringify(cfg)).not.toMatch(/Compare-Bypass|Probe-Token/);   // X-Compare-Bypass stays on /api/* only
  });

  it('every cacheable behavior of the app origin uses it; /api/* and /social/* keep AllViewer; cache policies unchanged', () => {
    const cacheable = [dist.DefaultCacheBehavior, ...dist.CacheBehaviors.filter((b) => !['/api/*', '/social/*'].includes(String(b.PathPattern)))];
    for (const b of cacheable) {
      const s = JSON.stringify(b.OriginRequestPolicyId);
      expect(s, String(b.PathPattern ?? 'default')).toContain('ExperimentOriginRequestPolicy');
    }
    const media = dist.CacheBehaviors.find((b) => b.PathPattern === '/media/*')!;
    expect(JSON.stringify(media.OriginRequestPolicyId)).toContain('S3Media');           // no experiment headers to an S3 origin
    for (const p of ['/api/*', '/social/*']) {
      expect(JSON.stringify(dist.CacheBehaviors.find((b) => b.PathPattern === p)!.OriginRequestPolicyId)).toContain('AllViewer');
    }
    expect(JSON.stringify(dist.DefaultCacheBehavior.CachePolicyId)).toContain('UseOriginCacheControlHeaders');
    expect(JSON.stringify(media.CachePolicyId)).toContain('MediaCachePolicy');
  });

  it('the lab response headers policy sets neither FrameOptions nor a CSP (the origin CSP passes through, PM-25)', () => {
    const cfg = JSON.stringify(t.Resources.LabResponseHeadersPolicy!.Properties);
    expect(cfg).not.toMatch(/FrameOptions|ContentSecurityPolicy/);
  });
});

describe('ec2 base stack: PlatformMode and atl:role (PM-05)', () => {
  const t = load('ec2.yaml');
  it('PlatformMode=off|on (default off) and atl:role=lab-app only under the Platform condition on both instance slots', () => {
    expect(t.Parameters.PlatformMode).toMatchObject({ Default: 'off', AllowedValues: ['off', 'on'] });
    for (const slot of ['InstanceA', 'InstanceB']) {
      const tags = JSON.stringify(t.Resources[slot]!.Properties!.Tags);
      expect(tags, slot).toContain('"Platform"');
      expect(tags, slot).toContain('atl:role');
    }
  });
});

describe('platform naming rules of every template (PM-29)', () => {
  it.each(TEMPLATES)('%s: no module parameter under /cloudalbum/<env>/atl/ (the workload boundary denies it)', (f) => {
    expect(JSON.stringify(load(f))).not.toMatch(/\/cloudalbum\/[^"]*\/atl\//);
  });

  it('iam: AppRoleMode=existing creates no CloudAlbumAppRole / instance profile', () => {
    const t = load('iam.yaml');
    expect(t.Parameters.AppRoleMode).toMatchObject({ Default: 'create' });
    for (const [name, r] of Object.entries(t.Resources)) {
      if (r.Type === 'AWS::IAM::Role' || r.Type === 'AWS::IAM::InstanceProfile') expect(r.Condition, name).toBe('CreateRole');
    }
  });
});
