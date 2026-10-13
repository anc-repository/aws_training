/** 本组画面使用的浏览器存储键（08 §2.5：只存界面偏好，键名带版本号；读写一律经 lib/storage 的 try/catch 包装）。 */
/** 目录上次的视图、分组与筛选（localStorage，05 §2.7 规则 4）。 */
export const CATALOG_PREFS_KEY = 'atl.catalog.v1';
/** 首次设置被跳过：目录页显示一次可关闭的提示（sessionStorage，08 P00“交互”）。 */
export const SETUP_SKIPPED_KEY = 'atl.setup.skipped.v1';
/** 浏览器通知开关（localStorage，08 §3.9；P00 第 6 步与 P12 个人资料共用）。 */
export const NOTIFY_PREF_KEY = 'atl.notify.v1';
