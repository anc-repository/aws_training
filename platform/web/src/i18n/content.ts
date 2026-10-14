/**
 * 按语言读取卡片内容（09 §2.4，决定 I4）。
 *
 * `labs:build` 在 `content/<v>/` 下发布源语言（zh-CN）的文件，并在 `content/<v>/<lang>/` 下发布 ja、en 的同名文件
 * （catalog/index.json、catalog/cards/<id>.json、labs/<id>.json、tracks/<id>.json；文本已按回退链解析）。每个按语言生成的
 * 文档带 `i18n: { lang, fallback: [JSON 指针…] }`，列出显示了其他语言的字段，界面据此加“未翻訳”标记。
 *
 * - `contentUrl()`：把 `/content/<v>/<rel>` 改写成当前语言的地址（zh-CN 用根路径）；
 * - `fetchContentJson()`：带 `Accept-Language` 读取；所选语言的文件不存在（旧的内容版本）时退回根路径，并把整份文档标为未翻译；
 * - `untranslated(doc, pointer)`：某个字段是否显示了其他语言。
 */
import { getLocale } from './runtime';
import type { Locale } from './locale';

export interface ContentI18n {
  /** 文档请求的语言 */
  lang: Locale;
  /** 显示了其他语言的字段（相对于该文档的 JSON 指针，例如 `/title`、`/steps/2/title`） */
  fallback?: string[];
  /** 整份文档都是源语言（所选语言的文件不存在） */
  whole?: boolean;
}

const CONTENT_RE = /^(\/content\/[^/?#]+\/)(?:(?:ja|en|zh-CN)\/)?(.*)$/;

/** `/content/<v>/<rel>` → 当前语言的地址；不是内容地址时原样返回。 */
export function contentUrl(url: string, lang: Locale = getLocale()): string {
  const m = CONTENT_RE.exec(url);
  if (!m) return url;
  return lang === 'zh-CN' ? `${m[1]}${m[2]}` : `${m[1]}${lang}/${m[2]}`;
}

/** 根路径（源语言）的地址。 */
export function sourceContentUrl(url: string): string {
  return contentUrl(url, 'zh-CN');
}

export interface FetchContentResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** 实际读取的地址 */
  url: string;
  error?: unknown;
}

/**
 * 读取一份内容 JSON（同源）。所选语言的文件 404 时读根路径，结果的 `i18n` 记为 `{ lang, whole: true }`。
 * 网络错误抛出；其他非 2xx 返回 `ok: false`。
 */
export async function fetchContentJson<T>(url: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis), lang: Locale = getLocale()): Promise<FetchContentResult<T>> {
  const first = contentUrl(url, lang);
  const headers = { accept: 'application/json', 'accept-language': lang };
  let r = await fetchImpl(first, { credentials: 'same-origin', headers });
  let used = first;
  let whole = false;
  if (r.status === 404 && lang !== 'zh-CN' && first !== sourceContentUrl(url)) {
    used = sourceContentUrl(url);
    r = await fetchImpl(used, { credentials: 'same-origin', headers });
    whole = r.ok;
  }
  if (!r.ok) return { ok: false, status: r.status, data: null, url: used };
  try {
    const data = (await r.json()) as T;
    if (whole && data && typeof data === 'object') (data as { i18n?: ContentI18n }).i18n = { lang, whole: true };
    return { ok: true, status: r.status, data, url: used };
  } catch (error) {
    return { ok: false, status: r.status, data: null, url: used, error };
  }
}

/** 文档或其中的一个元素（例如目录中的一张卡片）的语言信息。 */
export function contentI18n(doc: unknown): ContentI18n | null {
  const v = doc && typeof doc === 'object' ? (doc as { i18n?: unknown }).i18n : undefined;
  return v && typeof v === 'object' ? (v as ContentI18n) : null;
}

/**
 * 字段（JSON 指针，相对于带 `i18n` 的那个对象）是否显示了其他语言：整份文档未翻译、指针本身或其上级、其下级在回退列表中。
 * 指针省略时：该对象中是否有任何回退。
 */
export function untranslated(doc: unknown, pointer?: string): boolean {
  const i = contentI18n(doc);
  if (!i || i.lang === 'zh-CN') return false;
  if (i.whole) return true;
  const list = i.fallback ?? [];
  if (pointer === undefined) return list.length > 0;
  return list.some((p) => p === pointer || pointer.startsWith(`${p}/`) || p.startsWith(`${pointer}/`));
}

/** 手册文件实际的语言与请求不同（`manuals[file].lang`）。 */
export function manualUntranslated(manual: unknown, lang: Locale = getLocale()): boolean {
  const l = manual && typeof manual === 'object' ? (manual as { lang?: unknown }).lang : undefined;
  if (lang === 'zh-CN') return false;
  return typeof l !== 'string' || l !== lang;
}
