/**
 * Upload a packaged release to your own same-region bucket for a source deployment (01 §4.9, 07 V5-1 a):
 *   npm run publish:s3 -w @atl/infra -- --bucket my-atl-dev-artifacts --prefix atl/dev [--profile p] [--region r] [--dry-run]
 * Uses the AWS CLI with your profile (never write access keys into scripts). Prints the `aws cloudformation deploy` command
 * to run next (ArtifactSource=s3, ArtifactBaseUrl=s3://<bucket>/<prefix>, ReleaseVersion=dev): CopyArtifacts then verifies
 * every file against the SHA256SUMS uploaded here. The template is larger than the 51,200-byte inline limit, so the deploy
 * command passes --s3-bucket. --dry-run prints the commands without running them (no AWS call).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { releaseDir, releaseTag, TEMPLATE_FILE_NAME } from './merge-template.js';

export interface PublishPlan {
  commands: string[][];
  deploy: string;
}

export function publishPlan(opts: { dir: string; bucket: string; prefix: string; profile?: string; region?: string }): PublishPlan {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(opts.bucket)) throw new Error(`invalid bucket name ${opts.bucket}`);
  const prefix = opts.prefix.replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._/-]*$/.test(prefix)) throw new Error(`invalid prefix ${opts.prefix}`);
  const common = [...(opts.profile ? ['--profile', opts.profile] : []), ...(opts.region ? ['--region', opts.region] : [])];
  const files = fs
    .readdirSync(opts.dir)
    .filter((f) => !['launch-stack.md', 'release-manifest.json'].includes(f))
    .sort();
  if (!files.includes('SHA256SUMS') || !files.includes(TEMPLATE_FILE_NAME)) {
    throw new Error(`${opts.dir} is not a packaged release (run npm run package -w @atl/infra)`);
  }
  const base = prefix ? `s3://${opts.bucket}/${prefix}` : `s3://${opts.bucket}`;
  const commands = files.map((f) => ['aws', 's3', 'cp', path.join(opts.dir, f), `${base}/${f}`, '--only-show-errors', ...common]);
  const continuation = ' \\\n';
  const deploy = [
    'aws cloudformation deploy --stack-name atl',
    `  --template-file ${path.join(opts.dir, TEMPLATE_FILE_NAME)}`,
    `  --s3-bucket ${opts.bucket} --s3-prefix ${prefix ? `${prefix}/cfn` : 'cfn'}`,
    '  --capabilities CAPABILITY_NAMED_IAM',
    `  --parameter-overrides LearnerEmail=<your e-mail> ArtifactSource=s3 ArtifactBaseUrl=${base} ReleaseVersion=dev`,
    ...(common.length ? [`  ${common.join(' ')}`] : []),
  ].join(continuation);
  return { commands, deploy };
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bucket = get('--bucket');
  if (!bucket) throw new Error('usage: publish:s3 -- --bucket <bucket> [--prefix atl/dev] [--profile p] [--region r] [--dir release-dir] [--dry-run]');
  const plan = publishPlan({
    dir: get('--dir') ?? releaseDir(releaseTag()),
    bucket,
    prefix: get('--prefix') ?? 'atl/dev',
    profile: get('--profile'),
    region: get('--region'),
  });
  for (const c of plan.commands) {
    console.log(c.join(' '));
    if (!argv.includes('--dry-run')) execFileSync(c[0]!, c.slice(1), { stdio: 'inherit' });
  }
  console.log(`\nnext:\n${plan.deploy}`);
}

if (process.argv[1] && /publish-s3\.(ts|js)$/.test(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
