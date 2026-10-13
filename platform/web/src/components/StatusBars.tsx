/**
 * 离线条 OfflineBar（08 P13 #1）与页脚状态条（§3.1：平台版本、目录版本、区域、轮询状态，窄屏隐藏）。
 * 页脚的轮询间隔按当前会话状态计算（与 SessionSync 用同一个函数 viewIntervalMs）。
 */
import { useConnectivity, useServices, useSessionSync } from '../app/context';
import { useGlobalStatus } from '../app/globalStatus';
import { NO_SESSION_POLL_MS, viewIntervalMs } from '../api/sessionSync';
import { t, zhCN } from '../i18n/zh-CN';
import { Shape } from '../ui';

export function OfflineBar() {
  const c = useConnectivity();
  if (!c.offline) return null;
  return (
    <div className="offline no-print" role="status">
      <Shape name="xbox" />
      <span>{zhCN.p13.offline}</span>
    </div>
  );
}

export function FooterStatus() {
  const { clock } = useServices();
  const c = useConnectivity();
  const { current } = useSessionSync();
  const { platform, catalog } = useGlobalStatus();
  const ms = current ? viewIntervalMs(current, { nowMs: clock.now(), allHidden: false, solo: false, explicit: false }) : NO_SESSION_POLL_MS;
  const f = zhCN.footer;
  const skew = clock.skewMinutes;
  return (
    <footer className="foot">
      <span>ATL {platform.data?.version ?? ''}</span>
      {catalog?.catalogVersion ? <span>目录 {catalog.catalogVersion}</span> : null}
      {platform.data?.region ? <span className="mono">{platform.data.region}</span> : null}
      {c.offline ? (
        <span className="st fail">
          <Shape name="xbox" />
          <span className="t">{f.offline}</span>
        </span>
      ) : ms === null ? (
        <span className="st faint">
          <Shape name="ring" />
          <span className="t">{f.paused}</span>
        </span>
      ) : (
        <span className="st pass">
          <Shape name="dot" />
          <span className="t">{t(f.live, { s: Math.round(ms / 1000) })}</span>
        </span>
      )}
      {skew ? <span className="small">{t(f.clockSkew, { n: skew })}</span> : null}
      <span className="spacer" />
      <span className="faint kbd-hint">{f.shortcutsHint}</span>
    </footer>
  );
}
