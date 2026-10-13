// TaggerPort 契约测试：none 驱动（基础属性标签 + EXIF 启发式，审核恒为 pass）
import { describe, expect, it } from 'vitest';
import { NoTagger, basicLabels, colorName, orientationOf, resolutionTier, seasonOf } from '../../src/adapters/tagging/none.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import type { TaggerPort } from '../../src/ports/tagger.js';
import { adapterDeps, testConfig, testDb } from '../helpers/media-fixtures.js';

/** 所有 TaggerPort 驱动共有的行为（rekognition 驱动也必须输出基础标签） */
export function taggerContract(name: string, make: () => Promise<TaggerPort>): void {
  describe(`TaggerPort 契约：${name}`, () => {
    it('analyze 输出基础标签（source=basic）、审核结论与 analyzedBy', async () => {
      const t = await make();
      const r = await t.analyze({
        photoId: 'p1', storageKey: 'raw/u/p1.jpg',
        meta: { width: 1920, height: 1080, format: 'jpeg', dominantColor: '#1e5ac8', takenAt: '2024-07-15T01:20:30.000Z' },
        bytes: async () => Buffer.alloc(0),
      });
      const basic = r.labels.filter((l) => l.source === 'basic').map((l) => l.name);
      expect(basic).toEqual(expect.arrayContaining(['orientation:landscape', 'color:blue', 'res:hd', 'year:2024', 'season:summer', 'format:jpeg']));
      expect(['pass', 'review', 'block']).toContain(r.moderation.verdict);
      expect(r.analyzedBy.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
}

taggerContract('none', async () => new NoTagger(adapterDeps(testConfig())));

describe('NoTagger', () => {
  it('不读图片字节；审核恒为 pass；路径头 tagging=none:basic', async () => {
    const t = new NoTagger(adapterDeps(testConfig()));
    let read = false;
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => t.analyze({
      photoId: 'p', storageKey: 'raw/u/p.png', meta: { width: 100, height: 100, format: 'png', dominantColor: '#ffffff' },
      bytes: async () => { read = true; return Buffer.alloc(0); },
    }));
    expect(read).toBe(false);
    expect(r.moderation).toEqual({ verdict: 'pass', labels: [] });
    expect(r.analyzedBy).toMatchObject({ driver: 'none', input: 'metadata' });
    expect(r.labels.every((l) => l.confidence === 100 && l.source === 'basic')).toBe(true);
    expect(ctx.path.get('tagging')).toBe('none:basic');
  });

  it('probe：标签表可读', async () => {
    const db = await testDb();
    const t = new NoTagger(adapterDeps(testConfig(), { db }));
    expect((await t.probe()).status).toBe('ok');
    await db.destroy();
  });
});

describe('基础属性标签规则', () => {
  it('方向、分辨率档、季节', () => {
    expect(orientationOf(1600, 900)).toBe('landscape');
    expect(orientationOf(900, 1600)).toBe('portrait');
    expect(orientationOf(1000, 1020)).toBe('square');
    expect(resolutionTier(640, 480)).toBe('small');
    expect(resolutionTier(1920, 1080)).toBe('hd');
    expect(resolutionTier(6000, 4000)).toBe('4k+');
    expect([1, 3, 6, 9, 12].map(seasonOf)).toEqual(['winter', 'spring', 'summer', 'autumn', 'winter']);
  });

  it('12 色命名', () => {
    expect(colorName('#000000')).toBe('black');
    expect(colorName('#ffffff')).toBe('white');
    expect(colorName('#808080')).toBe('gray');
    expect(colorName('#e01010')).toBe('red');
    expect(colorName('#ff8800')).toBe('orange');
    expect(colorName('#f0e020')).toBe('yellow');
    expect(colorName('#20c040')).toBe('green');
    expect(colorName('#20c8c8')).toBe('cyan');
    expect(colorName('#2040e0')).toBe('blue');
    expect(colorName('#8020c0')).toBe('purple');
    expect(colorName('#e040a0')).toBe('pink');
    expect(colorName('#6b3a12')).toBe('brown');
    expect(colorName('nope')).toBeNull();
  });

  it('EXIF：相机品牌标签；没有拍摄时间就不生成年份与季节', () => {
    const labels = basicLabels({ width: 10, height: 10, format: 'webp', dominantColor: '#00ff00', camera: 'NIKON CORPORATION' }).map((l) => l.name);
    expect(labels).toContain('camera:nikon-corporation');
    expect(labels).toContain('format:webp');
    expect(labels.some((l) => l.startsWith('year:'))).toBe(false);
  });
});
