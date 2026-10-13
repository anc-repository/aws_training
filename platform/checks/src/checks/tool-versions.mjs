// tool-versions (04 §6.4): workstation tools (aws-cli, node, k6) and the repository commit.
import { PATHS } from '../lib/context.mjs';

async function first(ctx, cmd, args) {
  const r = await ctx.exec(cmd, args, { timeoutMs: 8000 });
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || null;
}

export default async function toolVersions(_args, ctx) {
  const repoCommit = await first(ctx, 'git', ['-C', ctx.dev ? process.cwd() : PATHS.repoDir, 'rev-parse', 'HEAD']);
  return {
    awsCli: await first(ctx, 'aws', ['--version']),
    node: process.version,
    k6: await first(ctx, 'k6', ['version']),
    repoCommit,
  };
}
