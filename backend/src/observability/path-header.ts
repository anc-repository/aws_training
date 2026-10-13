// backend/src/observability/path-header.ts —— 生成 X-CloudAlbum-Path（§7.2）
//
// 段顺序：entry（Nginx 的 $ca_entry，经 X-CloudAlbum-Entry 请求头传入）、inst、az（InstanceLifecyclePort.identity()，
// 启动时写入 setInstanceIdentity）、本次请求实际调用过的模块（首次调用顺序）、bypass。超过 512 字节截断并追加 more=N。
import { formatPathHeader, pathSignature } from '@cloudalbum/contracts';
import type { RequestContext } from './request-context.js';

interface InstanceIdentity { instanceId?: string; az?: string }
let identity: InstanceIdentity = {};

/** container 在启动时调用（autoscaling 的 single 驱动从 IMDS 读出；拿不到时留空，路径头不输出 inst / az） */
export function setInstanceIdentity(id: InstanceIdentity): void {
  identity = { ...id };
}

export function instanceIdentity(): Readonly<InstanceIdentity> {
  return identity;
}

/** 没有 Nginx（开发机直连 Node）时 entry 记为 `direct` */
export const DIRECT_ENTRY = 'direct';

export function buildPathHeader(ctx: RequestContext): string {
  return formatPathHeader({
    entry: ctx.entry || DIRECT_ENTRY,
    ...(identity.instanceId ? { inst: identity.instanceId } : {}),
    ...(identity.az ? { az: identity.az } : {}),
    modules: ctx.path.entries(),
    bypass: [...ctx.bypass],
  });
}

/** 路径签名（去掉 inst / az），LabMetricsStore 用它分组 */
export function buildPathSignature(ctx: RequestContext): string {
  return pathSignature(buildPathHeader(ctx));
}
