/**
 * 运行时配置 `/config.json`（01 §10.6：以 fetch 读取，不注入页面；安装时由 WebDeploy 覆盖）。
 * 生产字段见 platform/infra/src/90-install.yaml 的 WebDeploy.Config：apiBase、region、userPoolId、clientId、
 * domain（完整的托管登录域名）、platformUrl、redirectUri、logoutUri、version、releaseVersion。
 * 本地开发的占位文件（public/config.json）另有 `"auth": "dev"`：只有页面运行在本机开发地址时才启用开发令牌。
 */

export interface PlatformConfigJson {
  apiBase: string;
  region?: string;
  userPoolId?: string;
  clientId?: string;
  /** 托管登录域名，例如 `atl-1a2b3c4d.auth.ap-northeast-1.amazoncognito.com`。 */
  domain?: string;
  platformUrl?: string;
  redirectUri?: string;
  logoutUri?: string;
  version?: string;
  releaseVersion?: string;
  /** 仅本地开发：`dev` = 使用 dev-server 认可的开发令牌（platform/api/src/dev/adapters/auth.ts）。 */
  auth?: 'cognito' | 'dev';
}

export type AuthMode = 'cognito' | 'dev';

/** 本机开发地址：localhost、127.0.0.1、[::1]、*.localhost。 */
export function isLocalDevHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/**
 * 选择认证方式：`auth: "dev"` 只在本机开发地址生效（生产的 config.json 由 WebDeploy 写入，不含这个字段；
 * 即使被误写，非本机地址也不会启用开发令牌，生产 API 也只认 Cognito 令牌）。
 */
export function authModeOf(cfg: PlatformConfigJson, hostname: string): AuthMode | null {
  if (cfg.auth === 'dev') return isLocalDevHost(hostname) ? 'dev' : null;
  return cfg.domain && cfg.clientId ? 'cognito' : null;
}

export async function loadConfig(fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<PlatformConfigJson> {
  const res = await fetchImpl('/config.json', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`/config.json: HTTP ${res.status}`);
  const cfg = (await res.json()) as Partial<PlatformConfigJson>;
  return { ...cfg, apiBase: typeof cfg.apiBase === 'string' && cfg.apiBase ? cfg.apiBase : '/api/v1' };
}
