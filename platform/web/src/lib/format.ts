/**
 * 时间与时长格式（08 §1.6、§8.11；取自原型 fmtDur / fmtSpan / fmtClock / fmtDate）。
 *
 * - 倒计时与“已用”计时器：`1:42:10` / `42:10` / 最后 1 分钟 `0:42`（`0:42` 表示 42 秒）——`formatCountdown`
 * - 已经过去的时长（用时、环境年龄、合计）：`1 小时 31 分` / `58 分`，不用冒号格式——`formatSpan`
 * - 绝对时间：`16:30`（本地时区）；日期：当年 `10/13 10:42`，跨年 `2026-10-13`——`formatClock` / `formatDate`
 * - 粗粒度剩余：`剩余约 36 分钟`——`formatRemainingCoarse`
 * 单位文案在词典 `fmt`（09 §1.4）；时刻与日期按当前语言用 Intl 格式化（zh-CN 保持上面的写法）。
 */
import { fmtClock, fmtDate, msg, t } from '../i18n/core';

const pad = (n: number): string => String(n).padStart(2, '0');

/** 倒计时 / 计时器格式；负数按 0 处理。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 已经过去的时长：“1 小时 31 分”“58 分”“2 小时”。 */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  if (!h) return t(msg.fmt.spanM, { m: r });
  return r ? t(msg.fmt.spanHM, { h, m: r }) : t(msg.fmt.spanH, { h });
}

/** 读屏用的剩余时间：“1 小时 42 分”“12 分钟”“42 秒”。 */
export function formatRemainingSpoken(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return t(msg.fmt.spokenS, { s: total });
  const minutes = Math.ceil(total / 60);
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  if (!h) return t(msg.fmt.spokenM, { m: r });
  return r ? t(msg.fmt.spokenHM, { h, m: r }) : t(msg.fmt.spokenH, { h });
}

/** 粗粒度剩余：“剩余约 36 分钟”（不用 `0:36` 表示 36 分钟，§1.6）。 */
export function formatRemainingCoarse(ms: number): string {
  return t(msg.fmt.remainingCoarse, { t: formatRemainingSpoken(ms) });
}

export function formatClock(at: number | string | Date): string {
  return fmtClock(at);
}

/** 当年 `10/13 10:42`；跨年 `2026-10-13`。`now` 用于判断“当年”（默认本地时钟，界面传 serverClock.now()）。 */
export function formatDate(at: number | string | Date, now: number = Date.now()): string {
  return fmtDate(at, now);
}

/** 悬停显示的 UTC 时间（§8.11：所有时间显示为本地时区，悬停显示 UTC）。 */
export function formatUtcTitle(at: number | string | Date): string {
  return new Date(at).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}
