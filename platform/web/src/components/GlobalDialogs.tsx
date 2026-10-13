/**
 * P13 的全局对话框：登录过期（#5，静默刷新失败后的 401）与需要最近登录（#6，403 REAUTH_REQUIRED → ReauthDialog）。
 * - 登录过期：“你在本页填写的内容会保留在本标签页”（草稿由各画面存 sessionStorage）；[重新登录] 回到当前路由；
 * - 需要最近登录：[重新登录] [取消]；原请求（含同一个 Idempotency-Key）存 sessionStorage，登录回来后 15 分钟内由画面调用
 *   takeReauthReplay() 取回并经 ApiClient.replay() 重放（托管登录能否强制重新认证以 Cognito 官方文档为准，08 V-1）。
 */
import { useLocation } from 'react-router-dom';
import type { PendingRequest } from '../api/client';
import { useGlobalErrors, useServices } from '../app/context';
import { loginRedirect } from '../app/guards';
import { zhCN } from '../i18n/zh-CN';
import { ssGet, ssSet } from '../lib/storage';
import { Button, Dialog } from '../ui';

export const REAUTH_REPLAY_KEY = 'atl.auth.replay.v1';
export const REAUTH_REPLAY_TTL_MS = 15 * 60_000;

export function saveReauthReplay(req: PendingRequest): void {
  ssSet(REAUTH_REPLAY_KEY, req);
}

/** 取回（并删除）等待重放的请求；超过 15 分钟或路由不符时返回 null。 */
export function takeReauthReplay(routeId?: string, nowMs: number = Date.now()): PendingRequest | null {
  const req = ssGet<PendingRequest | null>(REAUTH_REPLAY_KEY, null);
  if (!req) return null;
  if (routeId && req.routeId !== routeId) return null;
  ssSet(REAUTH_REPLAY_KEY, undefined);
  return nowMs - req.createdAt <= REAUTH_REPLAY_TTL_MS ? req : null;
}

export function GlobalDialogs() {
  const { errors, auth } = useServices();
  const state = useGlobalErrors();
  const loc = useLocation();
  const here = `${loc.pathname}${loc.search}${loc.hash}`;
  const p = zhCN.p13;
  const relogin = (reason: 'expired' | 'reauth') => {
    if (auth.mode === 'cognito') void auth.beginLogin(here);
    else window.location.assign(loginRedirect(here, reason));
  };
  return (
    <>
      <Dialog
        open={!!state.authExpired}
        onClose={() => errors.set({ authExpired: null })}
        title={p.authExpiredTitle}
        size="narrow"
        alert
        footer={
          <Button variant="primary" onClick={() => relogin('expired')}>
            {p.signInAgain}
          </Button>
        }
      >
        <p>{p.authExpired}</p>
      </Dialog>
      <Dialog
        open={!state.authExpired && !!state.reauth}
        onClose={() => errors.set({ reauth: null })}
        title={p.reauthTitle}
        size="narrow"
        initialFocus="[data-cancel]"
        footer={
          <>
            <button type="button" className="btn" data-cancel="" onClick={() => errors.set({ reauth: null })}>
              {zhCN.app.cancel}
            </button>
            <Button
              variant="primary"
              onClick={() => {
                if (state.reauth) saveReauthReplay(state.reauth.request);
                relogin('reauth');
              }}
            >
              {p.signInAgain}
            </Button>
          </>
        }
      >
        <p>{p.reauth}</p>
      </Dialog>
    </>
  );
}
