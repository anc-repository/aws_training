/** Lambda entry of atl-api (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { loadPlatformEnv } from '../../runtime/env.js';
import { createCognitoMemberDirectory } from '../../services/members/index.js';
import { createAwsWorkspaceAccess } from '../../services/workspace/access.js';
import { createWorkspaceProvider } from '../../services/workspace/provider.js';
import { createApiHandler } from './handler.js';

const env = loadPlatformEnv();

// 03 WorkspaceProvider (terminals, console federation, preview, app credentials) and the Cognito MemberDirectory (01 §5.4)
export const handler = createApiHandler(prodDeps, {
  workspace: createWorkspaceProvider({ access: createAwsWorkspaceAccess(env) }),
  memberDirectory: createCognitoMemberDirectory(env),
});
