// 模块注册表（modules/registry.yaml 生成的 @cloudalbum/contracts/registry）按需加载：单独成块，与 /api/capabilities 并行请求，
// 不进首屏主包。徽章文案（lab.badges）与 /lab 卡片文案都来自这里（总纲 12.1 第 4 条：前端组件通用，不为单个模块写 UI 代码）。
import type { ModuleGroup, ModuleId, RegistryDocument, RegistryModule } from '@cloudalbum/contracts';

let pending: Promise<RegistryDocument> | null = null;

export function loadRegistry(): Promise<RegistryDocument> {
  pending ??= import('@cloudalbum/contracts/registry').then((m) => m.REGISTRY_DOCUMENT);
  return pending;
}

export const GROUP_LABEL: Record<ModuleGroup, string> = {
  base: '基础（EC2）',
  A: 'A · 边缘、网络与伸缩',
  B: 'B · 身份与安全',
  C: 'C · 数据与存储',
  D: 'D · 计算与异步',
  E: 'E · 运维与可观测',
  F: 'F · 治理与成本',
};

export const GROUP_ORDER: ModuleGroup[] = ['base', 'A', 'B', 'C', 'D', 'E', 'F'];

/** 总纲 3.1：A = adapter，A·P = param，I = infra */
export function typeMark(m: Pick<RegistryModule, 'type'>): string {
  switch (m.type) {
    case 'adapter': return 'A';
    case 'param': return 'A·P';
    case 'infra': return 'I';
    default: return 'base';
  }
}

/** 本轮（MVP）已实现 AWS 适配器的模块；其余模块的 AWS 取值在启动时以退出码 78 拒绝（config/implemented.ts） */
export const MVP_MODULES: readonly ModuleId[] = ['iam', 'storage', 'cdn', 'auth', 'queue', 'image-processing', 'cache', 'database'];

export function badgesOf(reg: RegistryDocument | null | undefined, id: ModuleId): Record<string, string> {
  const raw = reg?.modules[id]?.lab?.badges;
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}
