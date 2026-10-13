// aws-cred-source (04 §6.4, svc-iam): does the application use the instance role or access keys? Presence only.
import fs from 'node:fs';

export default async function awsCredSource(_args, ctx) {
  const info = await ctx.imds('iam/info').catch(() => ({ status: 0, value: null }));
  let imdsRole = null;
  if (info.status === 200 && info.value) {
    try {
      imdsRole = JSON.parse(info.value).InstanceProfileArn ?? null;
    } catch {
      imdsRole = null;
    }
  }
  const iam = ctx.moduleEnv('iam') ?? {};
  const appMode = iam.IAM_CREDENTIALS ?? null;
  let envHasKeys = false;
  for (const file of [`${ctx.paths.etc}/cloudalbum.env`, `${ctx.paths.etc}/secrets.env`]) {
    try {
      if (/^\s*AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*=\s*\S+/m.test(fs.readFileSync(file, 'utf8'))) envHasKeys = true;
    } catch {
      /* missing */
    }
  }
  let credentialsFile = false;
  for (const f of ['/home/cloudalbum/.aws/credentials', '/var/lib/cloudalbum/.aws/credentials', '/root/.aws/credentials']) {
    if (fs.existsSync(f)) credentialsFile = true;
  }
  const sdkSourceHint = envHasKeys ? 'environment' : credentialsFile ? 'shared-credentials-file' : imdsRole ? 'instance-profile' : 'none';
  return { imdsRole, appMode, envHasKeys, credentialsFile, sdkSourceHint };
}
