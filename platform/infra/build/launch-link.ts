/**
 * Launch Stack links (01 §4.2): one quick-create URL per verified region, same template, stack name atl, with LearnerEmail
 * left empty and ReleaseVersion pre-filled. The template lives in the maintainer's public template bucket under
 * atl/<tag>/atl-platform.template.json (the only external dependency of Launch Stack, 01 §4.5).
 *   npm run launch-link -w @atl/infra -- [--tag v1.0.0] [--template-url https://…] [--regions ap-northeast-1,…]
 */
import { loadReleaseConfig, releaseTag, TEMPLATE_FILE_NAME, type ReleaseConfig } from './merge-template.js';

export function templateUrl(config: ReleaseConfig, tag: string): string {
  return `https://${config.templateBucket}.s3.amazonaws.com/atl/${tag}/${TEMPLATE_FILE_NAME}`;
}

export function launchStackUrl(region: string, url: string, tag: string): string {
  if (!/^[a-z]{2}-[a-z]+-[0-9]$/.test(region)) throw new Error(`invalid region ${region}`);
  const q = new URLSearchParams({ templateURL: url, stackName: 'atl', param_LearnerEmail: '', param_ReleaseVersion: tag });
  return `https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${q.toString()}`;
}

export function launchStackMarkdown(opts: { tag: string; config: ReleaseConfig; url?: string; regions?: string[] }): string {
  const url = opts.url ?? templateUrl(opts.config, opts.tag);
  const regions = opts.regions ?? opts.config.verifiedRegions;
  const lines = [
    `# AWS Training Lab ${opts.tag} — Launch Stack`,
    '',
    'Install into a dedicated practice account. Fill in LearnerEmail, acknowledge CAPABILITY_NAMED_IAM and create the stack (01 §4.2).',
    '',
    '| Region | Link |',
    '|---|---|',
    ...regions.map((r) => `| ${r} | [Launch Stack](${launchStackUrl(r, url, opts.tag)}) |`),
    '',
    `Template: ${url}`,
    '',
  ];
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const config = loadReleaseConfig();
  const tag = get('--tag') ?? releaseTag();
  const regions = get('--regions')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  process.stdout.write(launchStackMarkdown({ tag, config, url: get('--template-url'), regions }));
}

if (process.argv[1] && /launch-link\.(ts|js)$/.test(process.argv[1])) main();
