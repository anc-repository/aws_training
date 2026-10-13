// capabilities 的读取钩子（总纲 12.2）。
import { useContext, useEffect } from 'react';
import type {
  CapabilitiesResponse, CapabilityTransitionEvent, FeatureId, FeatureState, ModuleCapability, ModuleId, RegistryDocument,
} from '@cloudalbum/contracts';
import { createSocialApi, socialBaseUrl, type SocialApi } from '../api/social';
import { CapabilitiesContext, type CapabilitiesContextValue } from './CapabilitiesProvider';

export function useCapabilities(): CapabilitiesContextValue {
  const ctx = useContext(CapabilitiesContext);
  if (!ctx) throw new Error('useCapabilities 必须在 <CapabilitiesProvider> 内使用');
  return ctx;
}

/** 已加载时一定有值（Provider 在加载完成前不渲染子树） */
export function useCaps(): CapabilitiesResponse {
  const { caps } = useCapabilities();
  if (!caps) throw new Error('capabilities 尚未加载');
  return caps;
}

export function useCapability(module: ModuleId): ModuleCapability | undefined {
  return useContext(CapabilitiesContext)?.caps?.modules[module];
}

/** capabilities.features[id]；尚未加载时为 undefined */
export function useFeature(id: FeatureId | string): FeatureState | undefined {
  return useContext(CapabilitiesContext)?.caps?.features[id];
}

export function useRegistry(): RegistryDocument | null {
  return useContext(CapabilitiesContext)?.registry ?? null;
}

let socialCache: { base: string; api: SocialApi } | null = null;

/** 按 social-api.public.baseUrl 选址的社交接口（为空 = 同源 /social） */
export function useSocialApi(): SocialApi {
  const caps = useContext(CapabilitiesContext)?.caps;
  const base = socialBaseUrl(caps);
  if (!socialCache || socialCache.base !== base) socialCache = { base, api: createSocialApi(base) };
  return socialCache.api;
}

/**
 * 管理员在 /lab 时用 SSE 实时接收状态变化：先收一次 snapshot，再收 transition 事件。
 * 浏览器不支持 EventSource、或连接失败时，自动退回 60 秒轮询。
 */
export function useCapabilityStream(enabled: boolean): void {
  const ctx = useContext(CapabilitiesContext);
  const applySnapshot = ctx?.applySnapshot;
  const applyTransition = ctx?.applyTransition;
  const setStreaming = ctx?.setStreaming;
  useEffect(() => {
    if (!enabled || !applySnapshot || !applyTransition || !setStreaming) return undefined;
    const ES = globalThis.EventSource;
    if (typeof ES !== 'function') return undefined;
    let es: EventSource | null = null;
    try {
      es = new ES('/api/capabilities/stream', { withCredentials: true });
    } catch {
      return undefined;
    }
    setStreaming(true);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      es?.close();
      setStreaming(false);
    };
    es.addEventListener('snapshot', (ev) => {
      try {
        applySnapshot(JSON.parse((ev as MessageEvent<string>).data) as CapabilitiesResponse);
      } catch {
        /* 忽略格式错误的事件 */
      }
    });
    es.addEventListener('transition', (ev) => {
      try {
        applyTransition(JSON.parse((ev as MessageEvent<string>).data) as CapabilityTransitionEvent);
      } catch {
        /* 忽略 */
      }
    });
    es.onerror = () => {
      // 401/403 或网络中断：EventSource 会自动重连；连续失败时交回轮询
      if (es?.readyState === 2) close();
    };
    return close;
  }, [enabled, applySnapshot, applyTransition, setStreaming]);
}
