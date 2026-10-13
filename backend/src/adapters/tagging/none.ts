// backend/src/adapters/tagging/none.ts —— TaggerPort 的 `none` 驱动（本地实现，L0 默认）
//
// 只用 image-processing 产出的 ImageMeta（含 EXIF 启发式），不读图片字节，耗时微秒到毫秒级（04#tagging 第 1 节）：
//   orientation:landscape|portrait|square、color:<12 色命名>、res:small|hd|4k+、year:<yyyy>、season:<北半球季节>、
//   format:<jpeg|png|webp>、camera:<EXIF 品牌>（有 EXIF 时）。置信度 100、source='basic'；审核结论恒为 pass。
// basicLabels() 也供 rekognition 驱动复用（它永远同时输出基础标签，保证切换驱动后 color:blue 之类的搜索不失效）。
import { performance } from 'node:perf_hooks';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageMeta } from '../../ports/image-processor.js';
import type { TagResult, TaggerPort } from '../../ports/tagger.js';
import { markPath } from '../../observability/request-context.js';

export type BasicLabel = TagResult['labels'][number];

/** 主色（#rrggbb）→ 12 色命名调色板 */
export function colorName(hex: string): string | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  if (l < 0.12) return 'black';
  if (l > 0.92) return 'white';
  if (s < 0.15) return 'gray';
  if (h >= 15 && h < 45 && l < 0.4) return 'brown';
  if (h < 15 || h >= 345) return l > 0.75 ? 'pink' : 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 195) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

export function orientationOf(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  if (!width || !height) return 'square';
  const ratio = width / height;
  if (ratio > 1.05) return 'landscape';
  if (ratio < 0.95) return 'portrait';
  return 'square';
}

/** 分辨率档：< 1280×720 为 small，< 3840×2160 为 hd，否则 4k+ */
export function resolutionTier(width: number, height: number): 'small' | 'hd' | '4k+' {
  const px = width * height;
  if (px < 1280 * 720) return 'small';
  if (px < 3840 * 2160) return 'hd';
  return '4k+';
}

/** 北半球季节（按拍摄时间的月份） */
export function seasonOf(month: number): 'spring' | 'summer' | 'autumn' | 'winter' {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

/** 由元数据与 EXIF 生成基础属性标签（纯函数） */
export function basicLabels(meta: ImageMeta & { camera?: string }): BasicLabel[] {
  const out: BasicLabel[] = [];
  const add = (name: string) => out.push({ name, confidence: 100, source: 'basic' });
  if (meta.width && meta.height) {
    add(`orientation:${orientationOf(meta.width, meta.height)}`);
    add(`res:${resolutionTier(meta.width, meta.height)}`);
  }
  const color = meta.dominantColor ? colorName(meta.dominantColor) : null;
  if (color) add(`color:${color}`);
  if (meta.takenAt) {
    const d = new Date(meta.takenAt);
    if (!Number.isNaN(d.getTime())) {
      add(`year:${d.getUTCFullYear()}`);
      add(`season:${seasonOf(d.getUTCMonth() + 1)}`);
    }
  }
  const fmt = String(meta.format ?? '').toLowerCase().replace('jpg', 'jpeg');
  if (['jpeg', 'png', 'webp'].includes(fmt)) add(`format:${fmt}`);
  const camera = meta.camera?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (camera) add(`camera:${camera.slice(0, 40)}`);
  return out;
}

export class NoTagger implements TaggerPort {
  readonly meta: AdapterMeta = { module: 'tagging', driver: 'none', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    if (this.deps.db) {
      try {
        await this.deps.db('photo_labels').select('photo_id').limit(1);
        await this.deps.db('moderation_results').select('photo_id').limit(1);
      } catch (e) {
        return { status: 'error', detail: `标签表不可读：${(e as Error).message}` };
      }
    }
    return { status: 'ok', detail: '只有元数据算出的基础属性标签（方向、主色、分辨率、年份、季节、EXIF），审核恒为通过' };
  }

  async analyze(input: { photoId: string; storageKey: string; meta: ImageMeta; bytes: () => Promise<Buffer> }): Promise<TagResult> {
    const t0 = performance.now();
    const labels = basicLabels(input.meta);
    markPath('tagging', 'none:basic');
    return {
      labels,
      moderation: { verdict: 'pass', labels: [] },
      analyzedBy: { driver: 'none', durationMs: Math.round((performance.now() - t0) * 100) / 100, input: 'metadata' },
    };
  }
}
