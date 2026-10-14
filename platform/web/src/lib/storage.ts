/**
 * localStorage / sessionStorage 的 try/catch 包装（08 §2.5、P13 #29；原型 lsGet / lsSet / ssGet / ssSet）。
 * 键名带版本号 `atl.<area>.v1`；存储不可用（隐私模式、被禁用）时照常工作，读取返回默认值。
 * localStorage 只存界面偏好，不存任何会话数据与令牌。
 */

type Area = 'local' | 'session';

function store(area: Area): Storage | null {
  try {
    return area === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function read<T>(area: Area, key: string, fallback: T): T {
  try {
    const v = store(area)?.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function write(area: Area, key: string, value: unknown): boolean {
  try {
    const s = store(area);
    if (!s) return false;
    if (value === undefined) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const lsGet = <T>(key: string, fallback: T): T => read('local', key, fallback);
export const lsSet = (key: string, value: unknown): boolean => write('local', key, value);
export const ssGet = <T>(key: string, fallback: T): T => read('session', key, fallback);
export const ssSet = (key: string, value: unknown): boolean => write('session', key, value);

/** 存储键（集中登记，便于审查“不存会话数据与令牌”的约定）。 */
export const STORAGE_KEYS = {
  /** 主题偏好 system | light | dark（localStorage，08 §6.11） */
  theme: 'atl.theme.v1',
  /** 单键快捷键开关（localStorage，§3.8） */
  shortcuts: 'atl.shortcuts.v1',
  /** 界面语言 ja | en | zh-CN（localStorage，09 §1；没有时为日语） */
  locale: 'atl.locale.v1',
  /** 首次设置完成（回写前的降级，§2.4 表 1 第 6 条、§9.2 #4） */
  onboarded: 'atl.onboarded.v1',
  /** 已关闭的横幅（sessionStorage，§3.6：只在当前标签页内有效） */
  dismissedBanners: 'atl.banners.dismissed.v1',
  /** 刷新令牌（sessionStorage，01 §5.3）；dev 模式下是 dev 身份 */
  refreshToken: 'atl.auth.refresh.v1',
  /** 登录请求（PKCE code_verifier、state、next；回调后立即删除） */
  loginRequest: 'atl.auth.request.v1',
  /** 退出后回到 /auth/signed-out 的标记（Cognito 登出回调目前是 `/`，见 implementation-notes） */
  signedOut: 'atl.auth.signed-out.v1',
  /** 事件游标（sessionStorage，§7.2 第 3 条），后缀为 sid */
  eventsCursorPrefix: 'atl.events.',
} as const;
