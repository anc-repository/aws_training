/**
 * 下载（08 P07“导出回收报告”、P07-M“导出清单”、P09-C“下载离线验证包”）：
 * - 需要令牌的接口（回收清单 Markdown / JSON、离线验证包）不能用导航下载（令牌只在内存，01 §5.3），所以经 fetch 取回后以
 *   Blob 交给浏览器保存；
 * - 预签名下载链接（报告导出）一律以导航方式打开，不经 fetch（SPA 的 connect-src 不含 S3，08 P08）。
 */
import type { RouteId } from '@atl/shared';
import type { QueryValue } from '../../api/client';
import { errorFromResponse, networkError } from '../../api/errors';
import type { Services } from '../../app/services';

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function saveText(text: string, filename: string, type: string): void {
  saveBlob(new Blob([text], { type }), filename);
}

/** 带令牌读取一个接口的原始响应（Markdown 等非 JSON 内容），保存为文件。 */
export async function downloadFromApi(
  services: Pick<Services, 'api' | 'auth'>,
  routeId: RouteId,
  params: Record<string, string>,
  query: Record<string, QueryValue>,
  filename: string,
): Promise<void> {
  const url = services.api.url(routeId, params, query);
  const send = async () => {
    const token = await services.auth.getAccessToken();
    try {
      return await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      throw networkError(e);
    }
  };
  let res = await send();
  if (res.status === 401 && (await services.auth.refresh().catch(() => false))) res = await send();
  if (!res.ok) throw errorFromResponse(res.status, res.headers, await res.text().catch(() => ''));
  saveBlob(await res.blob(), filename);
}

/** 以导航方式打开预签名下载链接（不经 fetch）。 */
export function navigateDownload(url: string): void {
  window.location.assign(url);
}
