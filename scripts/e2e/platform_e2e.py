"""Browser end-to-end test of the ATL platform (npm run e2e:platform starts the servers and runs this file).

Python Playwright with the system Chrome (channel "chrome", headless). The SPA runs on Vite against the API dev server
(ATL_DEV_MODE=1, runner local-l0). Dev control endpoints (/__dev/*) stand in for what a test cannot do through the UI:
fast-forwarding the platform clock, the completion fixture of a learning path and the undeletable learner resource.

  python scripts/e2e/platform_e2e.py --web http://127.0.0.1:5174 --api http://127.0.0.1:8787 --out <dir> [--headed]

Writes <dir>/results.json and <dir>/screenshots/*.png; exit code 0 when every check passed.
No AWS API is called (the dev server never reaches AWS; this script only talks to 127.0.0.1).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Callable

from playwright.sync_api import Page, sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--web', required=True)
ap.add_argument('--api', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--csp-web', default='')
ap.add_argument('--headed', action='store_true')
ap.add_argument('--only', default='')
args = ap.parse_args()

WEB = args.web.rstrip('/')
API = args.api.rstrip('/')
OUT = args.out
SHOTS = os.path.join(OUT, 'screenshots')
os.makedirs(SHOTS, exist_ok=True)
CSP_WEB = args.csp_web.rstrip('/')
for host in (WEB, API) + ((CSP_WEB,) if CSP_WEB else ()):
    if not re.match(r'^http://(127\.0\.0\.1|localhost)(:\d+)?$', host):
        sys.exit(f'refusing a non-local URL: {host}')

SUB = f'e2e-{time.strftime("%H%M%S")}'
LEARNER = f'dev.learner.{SUB}'
T0 = time.time()
results: list[dict[str, Any]] = []
console_events: list[dict[str, Any]] = []
state: dict[str, Any] = {}


# ------------------------------------------------------------------------------------------------ reporting

def check(name: str, ok: bool, detail: Any = None) -> bool:
    d = detail if isinstance(detail, str) or detail is None else json.dumps(detail, ensure_ascii=False, default=str)
    results.append({'phase': state.get('phase', ''), 'name': name, 'ok': bool(ok), 'detail': (d or '')[:1500], 'atS': round(time.time() - T0, 1)})
    mark = 'PASS' if ok else 'FAIL'
    print(f'{time.time() - T0:7.1f}s  {mark}  [{state.get("phase", "")}] {name}' + (f'  — {d[:300]}' if d else ''), flush=True)
    return ok


class Abort(Exception):
    pass


def must(name: str, ok: bool, detail: Any = None) -> None:
    if not check(name, ok, detail):
        raise Abort(name)


def log(s: str) -> None:
    print(f'{time.time() - T0:7.1f}s        {s}', flush=True)


def shot(page: Page, name: str, full: bool = False) -> str:
    path = os.path.join(SHOTS, f'{name}.png')
    try:
        page.screenshot(path=path, full_page=full)
    except Exception as e:  # noqa: BLE001
        log(f'screenshot {name} failed: {e}')
    return path


# ------------------------------------------------------------------------------------------------ dev API helpers

def http(method: str, path: str, body: Any = None, token: str | None = LEARNER) -> tuple[int, Any]:
    url = f'{API}{path}'
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header('content-type', 'application/json')
    if token:
        req.add_header('authorization', f'Bearer {token}')
    if method == 'POST':
        req.add_header('idempotency-key', f'e2e-{time.time_ns()}')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode() or 'null'
            return r.status, json.loads(raw) if raw.strip()[:1] in '{[n' else raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw


def session(sid: str) -> dict[str, Any]:
    return http('GET', f'/api/v1/sessions/{sid}')[1] or {}


def iso_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)


def dev_now_ms() -> int:
    return iso_ms(http('GET', '/__dev/state', token=None)[1]['now'])


def skip_to(deadline_ms: int, offset_ms: int) -> float:
    """Fast-forward the platform clock so that it reads deadline + offset (offset < 0 = before the deadline)."""
    now = dev_now_ms()
    minutes = (deadline_ms + offset_ms - now) / 60_000
    if minutes > 0:
        http('POST', '/__dev/clock/skip', {'minutes': minutes}, token=None)
    return minutes


def wait_until(what: str, fn: Callable[[], Any], timeout_s: float = 120, every_s: float = 1.0) -> Any:
    t = time.time()
    last = None
    while time.time() - t < timeout_s:
        try:
            last = fn()
        except Exception as e:  # noqa: BLE001
            last = e
        else:
            if last:
                return last
        # sleep through Playwright so that its events (new pages, navigations) keep being processed
        pump = state.get('pump')
        pump(every_s * 1000) if pump else time.sleep(every_s)
    raise Abort(f'timed out after {timeout_s:.0f}s: {what} (last: {str(last)[:300]})')


def wait_state(sid: str, states: list[str], timeout_s: float = 300) -> dict[str, Any]:
    return wait_until(f'session {sid} in {states}', lambda: (lambda s: s if s.get('state') in states else None)(session(sid)), timeout_s, 1.5)


# ------------------------------------------------------------------------------------------------ browser helpers

def attach(page: Page, label: str) -> None:
    def on_console(m: Any) -> None:
        if m.type in ('error', 'warning'):
            console_events.append({'page': label, 'url': page.url, 'type': m.type, 'text': m.text[:400], 'atS': round(time.time() - T0, 1)})

    page.on('console', on_console)
    page.on('pageerror', lambda e: console_events.append({'page': label, 'url': page.url, 'type': 'pageerror', 'text': str(e)[:400], 'atS': round(time.time() - T0, 1)}))
    page.on('response', lambda r: console_events.append({'page': label, 'url': page.url, 'type': f'http{r.status}', 'text': f'{r.request.method} {r.url}'[:400], 'atS': round(time.time() - T0, 1)}) if r.status >= 400 else None)


def no_hscroll(page: Page) -> dict[str, int]:
    return page.evaluate('() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth })')


def dialog(page: Page, title_re: str):
    return page.locator('[role=dialog], [role=alertdialog]').filter(has=page.locator('h2', has_text=re.compile(title_re))).last


# ------------------------------------------------------------------------------------------------ phases

def phase_login(page: Page) -> None:
    state['phase'] = '1 login'
    page.goto(f'{WEB}/labs')
    page.wait_for_url(re.compile(r'/login\?next='))
    check('unauthenticated /labs → /login?next=/labs', '/login?next=%2Flabs' in page.url, page.url)
    page.locator('main select').first.select_option('learner')
    page.locator('input.mono').fill(SUB)
    shot(page, '01-login')
    page.get_by_role('button', name='以开发身份登录').click()
    page.wait_for_url(re.compile(r'/setup'), timeout=20_000)
    check('dev token login → first-run setup (P00)', '/setup' in page.url, page.url)
    # P00: 7 steps for a learner — step 1 needs “我已了解”, step 7 a learning path
    page.locator('main input[type=checkbox]').first.check()
    for _ in range(6):
        page.locator('main a.btn.primary').first.click()
        page.wait_for_timeout(400)
    page.locator('input[name=setup-track][value=quick-compare]').check()
    shot(page, '02-setup-step7')
    page.locator('[data-setup-finish]').click()
    page.wait_for_url(re.compile(r'/labs$|/labs\?'), timeout=20_000)
    page.get_by_role('heading', level=1, name='卡片目录').wait_for()
    check('setup finished → catalog (P02)', True, page.url)


def phase_catalog(page: Page) -> None:
    state['phase'] = '2 catalog'
    main = page.locator('[data-screen=P02]')
    main.wait_for()
    head = main.inner_text()[:200]
    check('catalog: 56 cards, 40 service + 16 scenario', '56 张卡片' in head and '40 张单服务' in head and '16 张场景' in head, head)
    page.locator('text=显示 56 / 56 张').wait_for(timeout=15_000)
    shot(page, '03-catalog-grid')
    # filters: a facet (type = scenario), the count follows, then clear
    page.get_by_role('button', name=re.compile(r'^场景\s*16')).click()
    page.locator('text=显示 16 / 56 张').wait_for(timeout=10_000)
    check('filter “场景” → 16 / 56, written to the query string', 'kind=' in page.url or 'type=' in page.url or '?' in page.url, page.url)
    page.get_by_role('button', name=re.compile(r'^场景\s*16')).click()
    page.locator('text=显示 56 / 56 张').wait_for(timeout=10_000)
    # search by the original lab number (“Lab 4” = svc-storage)
    page.locator('input[type=search]').fill('Lab 4')
    page.wait_for_timeout(800)
    hit = page.locator('a[href="/labs/svc-storage"]').count() > 0
    shown = re.search(r'显示 (\d+) / 56 张', main.inner_text())
    check('search “Lab 4” finds svc-storage (original lab number)', hit and shown is not None and int(shown.group(1)) <= 5, shown.group(0) if shown else None)
    page.locator('input[type=search]').fill('')
    page.wait_for_timeout(500)
    # planned cards are marked and cannot start
    check('planned cards are marked “即将推出”', main.locator('text=即将推出').count() > 0)
    # service map view
    page.get_by_role('link', name='服务地图').click()
    page.wait_for_url(re.compile(r'view=map'))
    page.wait_for_timeout(1200)
    cells = page.locator('[data-screen=P02] .svcmap button, [data-screen=P02] [data-cell], [data-screen=P02] .smap button').count()
    check('service map view (?view=map) renders the service cells', cells >= 20, f'{cells} cells')
    shot(page, '04-catalog-map')
    page.get_by_role('link', name='路径', exact=True).click()
    page.wait_for_url(re.compile(r'view=tracks'))
    page.wait_for_timeout(1200)
    txt = page.locator('[data-screen=P02]').inner_text()
    check('track view (?view=tracks) lists the learning paths', '点名对比快速路径' in txt and 'SAA 主线' in txt)
    shot(page, '05-catalog-tracks')
    page.get_by_role('link', name='卡片网格').click()
    page.wait_for_timeout(800)
    # the learning-progress disclosure of the global bar (08 §3.4)
    page.get_by_role('button', name=re.compile('^进度')).click()
    panel = page.locator('[data-progress-panel]')
    panel.wait_for(timeout=15_000)
    check('global bar “进度”: current path progress and the next recommended card', '点名对比快速路径' in panel.inner_text() and '下一张推荐' in panel.inner_text(), panel.inner_text()[:200])
    shot(page, '05b-progress-disclosure')
    page.keyboard.press('Escape')


def start_session(page: Page, shot_prefix: str | None) -> str:
    page.goto(f'{WEB}/labs/svc-storage')
    page.get_by_role('heading', level=1, name=re.compile('Amazon S3')).wait_for()
    page.get_by_role('button', name='开始实验').first.click()
    dlg = dialog(page, '^开始实验')
    dlg.wait_for()
    dlg.locator('text=报价').first.wait_for(timeout=20_000)
    text = dlg.inner_text()
    submit = dlg.locator('.dlg-foot button.btn.primary, footer button.btn.primary, button.btn.primary').last
    if shot_prefix:
        check('start dialog: quote (dev fixture labelled “不是 AWS 价格”), cost confirmation required', '不是 AWS 价格' in text and submit.get_attribute('aria-disabled') == 'true', text[:300])
        shot(page, f'{shot_prefix}-start-dialog')
    dlg.locator('input[type=checkbox]').last.check()
    must('cost confirmation enables “开始实验”', submit.get_attribute('aria-disabled') != 'true')
    submit.click()
    page.wait_for_url(re.compile(r'/workspace/s[0-9a-z]{12}'), timeout=30_000)
    return page.url.rsplit('/', 1)[-1].split('?')[0]


def phase_start(page: Page) -> str:
    state['phase'] = '3 start'
    page.goto(f'{WEB}/labs')
    page.locator('a[href="/labs/svc-storage"]').first.click()
    page.wait_for_url(re.compile(r'/labs/svc-storage'))
    page.locator('[data-screen=P03]').wait_for()
    check('card intro P03 (svc-storage)', page.locator('[data-screen=P03]').count() == 1)
    shot(page, '06-card-intro')
    sid = start_session(page, '07')
    state['sid'] = sid
    check('POST /sessions 202 → workspace', True, sid)
    page.locator('[data-screen=P04]').wait_for(timeout=20_000)
    txt = page.locator('[data-screen=P04]').inner_text()
    check('P04 provisioning: phases, billing note, countdown not started', '正在准备实验环境' in txt and '倒计时未开始' in txt and '计费' in txt, txt[:200])
    shot(page, '08-provisioning')
    log(f'session {sid}: waiting for READY (local L0 base-deploy, workstation, health gate) …')
    page.locator('[data-screen=P05][data-variant=live]').wait_for(timeout=300_000)
    s = session(sid)
    check('READY → P05 workbench (live); heartbeat → RUNNING', s.get('state') in ('READY', 'RUNNING'), s.get('state'))
    wait_state(sid, ['RUNNING'], 60)
    page.wait_for_timeout(1500)
    shot(page, '09-workbench')
    return sid


def phase_workbench(page: Page, sid: str) -> None:
    state['phase'] = '4 workbench'
    # left: run the checks of step 1 and show the results (step 1 explicitly: the manual moves on once a step is done)
    page.goto(f'{WEB}/workspace/{sid}?step=orient')
    page.locator('[data-screen=P05][data-variant=live] #chk-h-orient').wait_for(timeout=30_000)
    step = page.locator('#step-h-orient')
    check('manual pane shows step 1', step.count() == 1, step.get_attribute('id'))
    section = page.locator('#chk-h-orient').locator('xpath=ancestor::*[.//*[@data-result]][1]')
    started = time.time()
    section.get_by_role('button', name=re.compile('检测')).first.click()
    rows = section.locator('[data-result]')

    def results_done():
        vals = [rows.nth(i).get_attribute('data-result') for i in range(rows.count())]
        fresh = time.time() - started > 3
        return vals if fresh and vals and all(v not in (None, 'running', 'pending', 'queued', 'none', 'unchecked') for v in vals) else None

    vals = wait_until('step 1 check results', results_done, 120, 1)
    check('left: “检测” runs the step checks (dev check engine on the local L0) and shows the results', all(v == 'pass' for v in vals), vals)
    shot(page, '10-checks')
    # right: lab terminal through the ssm-client mock
    page.locator('#tab-terminal-lab').click()
    wait_until('lab terminal connected', lambda: '已连接' in page.locator('#tab-terminal-lab').inner_text(), 45, 0.5)
    page.locator('.xterm').first.click()
    page.keyboard.type('echo atl-e2e-ok')
    page.keyboard.press('Enter')
    # the typed line is echoed by the tty, the command prints it once more
    out = wait_until('terminal output', lambda: (lambda t: t if t.count('atl-e2e-ok') >= 2 else None)(page.locator('.xterm-rows').first.inner_text()), 20, 0.5)
    check('right: lab terminal (ssm-client ↔ mock data channel) — input and output', out.count('atl-e2e-ok') >= 2, out[-200:])
    page.keyboard.type('stty size')
    page.keyboard.press('Enter')
    size = wait_until('stty size', lambda: re.search(r'\n(\d+) (\d+)\s', page.locator('.xterm-rows').first.inner_text()), 10, 0.5)
    check('terminal size reaches the shell (stty size)', int(size.group(2)) > 20, size.group(0).strip())
    shot(page, '11-terminal')
    # right: AWS console → dev federation stub (form POST into a named new tab)
    page.locator('#tab-console').click()
    before = set(page.context.pages)
    page.get_by_role('button', name=re.compile('在新标签页打开 AWS 控制台')).click()
    console = wait_until('federation page', lambda: next((pg for pg in page.context.pages if '/__dev/federation' in pg.url), None), 30, 0.5)
    console.wait_for_load_state()
    body = console.locator('body').inner_text()
    extra = [pg.url for pg in page.context.pages if pg not in before and pg is not console]
    check('console button → dev federation login URL (getSigninToken → POST login form into the named tab, ATLLearnerRole)', 'ATLLearnerRole' in body and not extra, {'url': console.url, 'body': body[:160], 'strayTabs': extra})
    shot(console, '12-console-federation')
    console.close()
    # right: app preview — the local L0 entry is http (MIXED_CONTENT), so it opens in a new tab
    page.locator('#tab-preview').click()
    before = set(page.context.pages)
    page.get_by_role('button', name='在新标签页打开').last.click()
    app = wait_until('preview tab', lambda: next((pg for pg in page.context.pages if pg not in before and pg.url.startswith('http://127.0.0.1')), None), 20, 0.5)
    app.wait_for_load_state()
    check('app preview: the environment entry (local CloudAlbum L0) opens in a new tab', app.url.startswith('http://127.0.0.1'), app.url)
    shot(app, '12b-app-preview')
    app.close()
    phase_csp_live(page.context.browser, sid)
    state['phase'] = '4 workbench'


def resync_clock(page: Page) -> None:
    """After a dev clock jump: let the page re-sync its server clock now, as when a tab comes back to the foreground.

    A real server clock does not jump. Without a state change the session polls answer 304 (no serverNow sample) and the
    60 s heartbeat sample may be dropped for its round trip (ServerClock keeps the best sample), so the page could stay
    behind for longer than the 54 s the ×5 clock leaves between T-4.5 and the deadline.
    """
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")


def phase_expire(page: Page, sid: str) -> None:
    state['phase'] = '5 extend+expire'
    before = session(sid)
    page.get_by_role('button', name=re.compile(r'^延长 30 分钟（剩 2 次）')).click()
    dlg = dialog(page, '^延长 30 分钟')
    dlg.locator('[data-quote]').wait_for(timeout=20_000)
    dlg.locator('input[type=checkbox]').first.check()
    shot(page, '13-extend-dialog')
    dlg.locator('[data-extend-submit]').click()
    dlg.wait_for(state='detached', timeout=20_000)
    after = wait_until('deadlineVersion 2', lambda: (lambda s: s if s.get('deadlineVersion') == 2 else None)(session(sid)), 20, 0.5)
    check('extend 30 min: quote → confirm → deadline +30 min (deadlineVersion 2)', iso_ms(after['deadlineAt']) - iso_ms(before['deadlineAt']) == 30 * 60_000, {'before': before.get('deadlineAt'), 'after': after.get('deadlineAt')})
    page.get_by_role('button', name=re.compile(r'^延长 30 分钟（剩 1 次）')).wait_for(timeout=15_000)
    deadline = iso_ms(after['deadlineAt'])
    # time acceleration: the platform clock jumps to 16 minutes before the deadline → the w15 schedule → EXPIRING
    m = skip_to(deadline, -16 * 60_000)
    log(f'platform clock +{m:.1f} min (deadline − 16 min)')
    wait_state(sid, ['EXPIRING'], 90)
    page.locator('[data-banner=t15]').wait_for(timeout=60_000)
    t15 = page.locator('[data-banner=t15]').inner_text()
    check('T-15: EXPIRING and the amber banner “剩余 n 分钟”', '剩余' in t15 and '到期' in t15, t15)
    shot(page, '14-t15-banner')
    # T-5: the one-time reminder dialog
    skip_to(deadline, -int(4.5 * 60_000))
    resync_clock(page)
    t5 = dialog(page, '^还剩 5 分钟')
    t5.wait_for(timeout=60_000)
    check('T-5: the one-time “还剩 5 分钟” dialog', t5.is_visible())
    shot(page, '15-t5-dialog')
    t5.get_by_role('button', name='知道了').click()
    # deadline: exp schedule → ENDING (access revoked) → the overlay, then CLEANING → ENDED. The clock runs ×1 from here on,
    # so that ENDING / CLEANING last long enough for the 5–10 s polling to show them (at ×5 they pass within one poll)
    http('POST', '/__dev/clock/scale', {'scale': 1}, token=None)
    skip_to(deadline, 5_000)
    ovl = page.locator('[data-ws-overlay]')
    ovl.wait_for(timeout=90_000)
    check('expiry: the overlay “实验时间已到 / 实验已结束” (alertdialog)', ovl.get_attribute('role') == 'alertdialog', ovl.inner_text()[:120])
    shot(page, '16-expired-overlay')
    ovl.get_by_role('button', name='查看回收进度').click()
    page.wait_for_url(re.compile(rf'/sessions/{sid}/end'))
    page.locator('[data-screen=P07]').wait_for(timeout=20_000)
    shot(page, '17-reclaim-progress')
    check('P07 reclaim progress while ENDING / CLEANING', page.locator('[data-screen=P07]').get_attribute('data-state') in ('ENDING', 'CLEANING', 'ENDED'), page.locator('[data-screen=P07]').get_attribute('data-state'))
    page.locator('[data-screen=P07] [data-phases]').first.wait_for(timeout=20_000)
    shot(page, '17b-reclaim-phases', full=True)
    http('POST', '/__dev/clock/scale', {'scale': 5}, token=None)
    ended = wait_state(sid, ['ENDED', 'CLEANUP_FAILED', 'FAILED'], 300)
    check('reclaim → ENDED (EXPIRED)', ended.get('state') == 'ENDED', {'state': ended.get('state'), 'reason': ended.get('stateReason')})
    page.locator('[data-screen=P07][data-state=ENDED]').wait_for(timeout=60_000)
    shot(page, '18-reclaim-ended', full=True)


def phase_report(page: Page, sid: str) -> None:
    state['phase'] = '6 report+share'
    page.goto(f'{WEB}/sessions/{sid}/report')
    rep = page.locator('[data-screen=P08]')
    wait_until('report ready', lambda: (page.reload() if rep.get_attribute('data-report') in ('none', 'generating') else None) or rep.get_attribute('data-report') == 'ready', 120, 3)
    check('P08 report (final) after the end workflow', rep.get_attribute('data-report') == 'ready')
    shot(page, '19-report', full=True)
    page.get_by_role('button', name='分享…').first.click()
    dlg = dialog(page, '^创建分享链接')
    dlg.get_by_role('button', name='创建链接').click()
    dlg.locator('text=已创建').wait_for(timeout=20_000)
    shot(page, '20-share-created')
    dlg.get_by_role('button', name='关闭', exact=True).last.click()
    row = page.locator('[data-share]').first
    wait_until('share active', lambda: row.get_attribute('data-status') == 'active', 90, 1)
    share_id = row.get_attribute('data-share')
    code, html = http('GET', f'/share/{share_id}/index.html', token=None)
    check('share link created: published copy reachable without login (/share/<id>/index.html)', code == 200 and isinstance(html, str) and '<html' in html.lower(), {'shareId': share_id, 'status': code})
    sp = page.context.new_page()
    attach(sp, 'share')
    sp.goto(f'{WEB}/share/{share_id}/index.html')
    shot(sp, '21-share-copy', full=True)
    sp.close()
    row.get_by_role('button', name=re.compile('^撤销')).click()
    conf = dialog(page, '^撤销分享链接')
    conf.get_by_role('button', name='撤销').click()
    wait_until('share revoked', lambda: page.locator(f'[data-share="{share_id}"]').get_attribute('data-status') == 'revoked', 90, 1)
    code2, _ = http('GET', f'/share/{share_id}/index.html', token=None)
    check('share link revoked: listed “已撤销”, the copy is gone (403)', code2 in (403, 404), code2)
    shot(page, '22-share-revoked')


def phase_certificate(page: Page) -> None:
    state['phase'] = '7 certificate+verify'
    code, fx = http('POST', '/__dev/fixtures/completions', {'sub': SUB, 'trackId': 'quick-compare'}, token=None)
    must('dev fixture: completion records + verified badges for the quick-compare required cards', code == 200 and len(fx.get('labIds', [])) == 7, fx)
    page.goto(f'{WEB}/certificates')
    page.locator('[data-screen=P09]').wait_for()
    claim = page.get_by_role('button', name='领取…').first
    claim.wait_for(timeout=20_000)
    check('P09: quick-compare is claimable', claim.is_visible())
    claim.click()
    dlg = dialog(page, '^领取：')
    dlg.locator('input[type=checkbox]').check()
    shot(page, '23-claim-dialog')
    dlg.get_by_role('button', name='签发证书').click()
    page.wait_for_url(re.compile(r'/certificates/ATL-'), timeout=30_000)
    cert_id = page.url.rsplit('/', 1)[-1]
    state['certId'] = cert_id
    detail = page.locator('[data-screen=P09-C]')
    detail.wait_for()
    wait_until('certificate public', lambda: (page.reload() or True) and '已公开证书文件' in detail.inner_text(), 40, 3)
    check('certificate issued (ES256 JWS) and public → P09-C', detail.get_attribute('data-status') == 'valid', cert_id)
    shot(page, '24-certificate', full=True)
    vp = page.context.new_page()
    attach(vp, 'verify')
    vp.goto(f'{WEB}/verify/{cert_id}')
    res = vp.locator('#vres')
    wait_until('verify result', lambda: res.get_attribute('data-result') not in (None, 'verifying'), 30, 0.5)
    check('public verify page /verify/<certId> (P09-V, WebCrypto + jwks + signed revocation list): valid', res.get_attribute('data-result') == 'valid', res.inner_text()[:200])
    shot(vp, '25-verify-valid', full=True)
    # revoke in P09-C → the verify page shows “已吊销”
    page.get_by_role('button', name=re.compile('^吊销')).first.click()
    rd = dialog(page, '^吊销证书')
    rd.locator('input[type=radio]').first.check()
    rd.get_by_role('button', name='吊销').click()
    wait_until('revoked', lambda: (page.reload() or True) and detail.get_attribute('data-status') == 'revoked', 40, 2)
    check('P09-C: revoked', detail.get_attribute('data-status') == 'revoked')
    vp.reload()
    wait_until('verify result after revocation', lambda: res.get_attribute('data-result') not in (None, 'verifying'), 30, 0.5)
    check('verify page after revocation: “已吊销”', res.get_attribute('data-result') == 'revoked', res.inner_text()[:200])
    shot(vp, '26-verify-revoked', full=True)
    vp.close()


def phase_cleanup_failed(page: Page) -> None:
    state['phase'] = '8 cleanup-failed'
    sid = start_session(page, None)
    state['sid2'] = sid
    log(f'second session {sid}: waiting for READY …')
    page.locator('[data-screen=P05][data-variant=live]').wait_for(timeout=300_000)
    code, res = http('POST', '/__dev/reclaim/protected-resource', {'sessionId': sid}, token=None)
    must('fault: the learner created an RDS instance with deletion protection in the console (dev account + CloudTrail)', code == 200, res)
    # end it from the global session menu (catalog page): the workspace's EndDialog registered for the app layout
    page.goto(f'{WEB}/labs')
    page.get_by_role('button', name='会话菜单').click()
    page.locator('header .popover').get_by_role('button', name='结束实验…').click()
    dlg = dialog(page, '^结束实验')
    dlg.locator('[data-end-dialog]').wait_for()
    check('session menu “结束实验…” outside the workspace opens the real EndDialog (not the scaffold stub)', dlg.locator('[data-end-submit]').count() == 1)
    shot(page, '27-end-dialog')
    dlg.locator('[data-end-submit]').click()
    page.wait_for_url(re.compile(rf'/sessions/{sid}/end'), timeout=30_000)
    failed = wait_state(sid, ['CLEANUP_FAILED', 'ENDED'], 300)
    check('end (release now) → reclaim cannot delete it → CLEANUP_FAILED', failed.get('state') == 'CLEANUP_FAILED', failed.get('state'))
    page.locator('[data-screen=P07][data-state=CLEANUP_FAILED]').wait_for(timeout=60_000)
    shot(page, '28-cleanup-failed', full=True)
    page.goto(f'{WEB}/resources/manual')
    page.locator('[data-screen=P07-M]').wait_for()
    item = page.locator('[data-manual-list] [data-k]').first
    item.wait_for(timeout=30_000)
    check('P07-M: the manual-handling list shows the RDS instance with console link and CLI', 'db-protected' in page.locator('[data-screen=P07-M]').inner_text() or 'RDS' in item.inner_text(), item.inner_text()[:200])
    shot(page, '29-manual-list', full=True)
    http('POST', '/__dev/reclaim/delete-resource', {'type': res['type'], 'region': res['region'], 'id': res['id']}, token=None)
    item.get_by_role('button', name=re.compile('我已处理')).click()
    ended = wait_state(sid, ['ENDED'], 120)
    check('“我已处理，重新核对” → re-check → ENDED (RESOLVED_BY_LEARNER)', ended.get('state') == 'ENDED', ended.get('stateReason'))
    page.wait_for_timeout(3000)
    shot(page, '30-manual-resolved', full=True)
    page.goto(f'{WEB}/sessions/{sid}/end')
    page.locator('[data-screen=P07][data-state=ENDED]').wait_for(timeout=30_000)
    check('P07 shows the session ended', True)
    shot(page, '31-ended-after-resolve', full=True)


# 4xx responses that are part of a correct flow (status, regex on "METHOD url")
EXPECTED_4XX: list[tuple[int, str]] = []

SCREENS = [
    ('catalog', '/labs?view=grid', '[data-screen=P02]'),
    ('catalog-map', '/labs?view=map', '[data-screen=P02]'),
    ('card', '/labs/svc-storage', '[data-screen=P03]'),
    ('track', '/tracks/quick-compare', 'h1'),
    ('workspace', '/workspace/{sid}', '[data-screen]'),
    ('sessions', '/sessions', 'h1'),
    ('session-detail', '/sessions/{sid}', 'h1'),
    ('reclaim', '/sessions/{sid}/end', '[data-screen=P07]'),
    ('report', '/sessions/{sid}/report', '[data-screen=P08]'),
    ('manual', '/resources/manual', '[data-screen=P07-M]'),
    ('certificates', '/certificates', '[data-screen=P09]'),
    ('certificate', '/certificates/{certId}', '[data-screen=P09-C]'),
    ('learning', '/learning', 'h1'),
    ('settings', '/settings/profile', 'h1'),
    ('verify', '/verify/{certId}', '#vres'),
    ('not-found', '/no/such/page', 'h1'),
]


def phase_screens(page: Page) -> None:
    state['phase'] = '9 screens'
    for width in (400, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        bad = []
        for name, path, sel in SCREENS:
            if ('{sid}' in path and 'sid' not in state) or ('{certId}' in path and 'certId' not in state):
                continue
            url = path.format(sid=state.get('sid'), certId=state.get('certId'))
            page.goto(f'{WEB}{url}')
            try:
                page.locator(sel).first.wait_for(timeout=20_000)
            except Exception:  # noqa: BLE001
                bad.append(f'{name}: {sel} not found')
            page.wait_for_timeout(1200)
            m = no_hscroll(page)
            if m['scroll'] > m['client'] + 1:
                bad.append(f'{name}: scrollWidth {m["scroll"]} > {m["client"]}')
            shot(page, f'w{width}-{name}', full=True)
        check(f'{width}px: {len(SCREENS)} screens render without horizontal scrolling', not bad, bad)
    page.set_viewport_size({'width': 1280, 'height': 900})


CSP_SCREENS = [
    ('catalog', '/labs?view=grid', '[data-screen=P02]'),
    ('catalog-map', '/labs?view=map', '[data-screen=P02]'),
    ('card', '/labs/svc-storage', '[data-screen=P03]'),
    ('workspace-archive', '/workspace/{sid}', '[data-screen]'),
    ('reclaim', '/sessions/{sid}/end', '[data-screen=P07]'),
    ('report', '/sessions/{sid}/report', '[data-screen=P08]'),
    ('certificate', '/certificates/{certId}', '[data-screen=P09-C]'),
    ('learning', '/learning', 'h1'),
    ('settings', '/settings/profile', 'h1'),
]

CSP_PROBE = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 80), source: `${e.sourceFile}:${e.lineNumber}` }));
"""


CSP_TERMINAL_PROBE = """
() => {
  const rows = document.querySelector('#panel-terminal-lab .xterm-rows');
  const spans = rows ? [...rows.querySelectorAll('span')] : [];
  const tc = spans.find((s) => s.textContent.includes('csp-truecolor') && s.style.color);
  return {
    terminals: document.querySelectorAll('.xterm').length,
    styleElements: document.querySelectorAll('style').length,
    adopted: document.adoptedStyleSheets.length,
    rowsFont: rows ? getComputedStyle(rows).fontFamily : null,
    bodyFont: getComputedStyle(document.body).fontFamily,
    rowsColor: rows ? getComputedStyle(rows).color : null,
    truecolor: tc ? getComputedStyle(tc).color : null,
    violations: window.__csp || [],
  };
}
"""


def csp_login(page: Page) -> None:
    page.goto(f'{CSP_WEB}/labs')
    page.locator('input.mono').fill(SUB)
    page.get_by_role('button', name='以开发身份登录').click()
    page.locator('[data-screen=P02]').wait_for(timeout=20_000)


def phase_csp_live(browser: Any, sid: str) -> None:
    """The production build under the CloudFront CSP with a live session: the workbench and an open lab terminal.

    xterm.js 6 injects <style> elements and style attributes at runtime; the SPA turns them into adopted constructable
    stylesheets and CSSOM writes (03 §3.7.6). No securitypolicyviolation, no <style> element, the rows in the monospace
    font and true-colour cells coloured. connect-src additionally lists the local SSM mock (scripts/e2e/platform.mjs).
    """
    if not CSP_WEB:
        return
    state['phase'] = '4b csp-live'
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='zh-CN', timezone_id='Asia/Tokyo')
    ctx.add_init_script(UI_LOCALE_ZH)
    ctx.add_init_script(CSP_PROBE)
    page = ctx.new_page()
    attach(page, 'csp-live')
    try:
        csp_login(page)
        page.goto(f'{CSP_WEB}/workspace/{sid}?step=orient')
        page.locator('[data-screen=P05][data-variant=live]').wait_for(timeout=30_000)
        lab = page.locator('#panel-terminal-lab')

        def lab_shown() -> bool:
            # the manual may move the right pane to the step's default panel once it has loaded: select the tab again
            if not lab.is_visible():
                page.locator('#tab-terminal-lab').click()
                return False
            return '已连接' in page.locator('#tab-terminal-lab').inner_text()

        wait_until('csp: lab terminal shown and connected', lab_shown, 45, 0.5)
        lab.locator('.xterm').first.click()
        page.keyboard.type(r"printf '\e[38;2;10;20;30mcsp-truecolor\e[0m \e[1;34mcsp-blue\e[0m\n'")
        page.keyboard.press('Enter')
        wait_until('csp: terminal output', lambda: lab.locator('.xterm-rows').first.inner_text().count('csp-truecolor') >= 2, 20, 0.5)
        page.wait_for_timeout(800)
        r = page.evaluate(CSP_TERMINAL_PROBE)
        shot(page, '11b-csp-live-terminal')
        mono = r['rowsFont'] or ''
        check('production CSP, live workbench + lab terminal: no securitypolicyviolation (xterm.js styles adopted, not inline)', not r['violations'] and r['styleElements'] == 0 and r['adopted'] >= 2, {k: r[k] for k in ('violations', 'terminals', 'styleElements', 'adopted')})
        check('production CSP: terminal rows use the monospace font (not the page font); true-colour cells are coloured', 'JetBrains Mono' in mono and mono != r['bodyFont'] and bool(r['truecolor']) and r['truecolor'] != r['rowsColor'], {k: r[k] for k in ('rowsFont', 'bodyFont', 'rowsColor', 'truecolor')})
    except Exception as e:  # noqa: BLE001 — recorded as a failure; the main flow goes on
        check(f'csp-live: {type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ""}', False, traceback.format_exc()[-1500:])
        shot(page, 'fail-csp-live', full=True)
    finally:
        ctx.close()


def phase_csp(browser: Any) -> None:
    """The production build (vite preview) under the atl-web-spa CSP header: no violations on the main screens."""
    state['phase'] = '9b csp'
    if not CSP_WEB:
        return
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='zh-CN', timezone_id='Asia/Tokyo')
    ctx.add_init_script(UI_LOCALE_ZH)
    ctx.add_init_script(CSP_PROBE)
    page = ctx.new_page()
    attach(page, 'csp')
    csp_login(page)
    found: list[dict[str, Any]] = []
    seen = 0
    for name, path, sel in CSP_SCREENS:
        if ('{sid}' in path and 'sid' not in state) or ('{certId}' in path and 'certId' not in state):
            continue
        page.goto(f'{CSP_WEB}{path.format(sid=state.get("sid"), certId=state.get("certId"))}')
        try:
            page.locator(sel).first.wait_for(timeout=20_000)
        except Exception:  # noqa: BLE001
            found.append({'screen': name, 'error': f'{sel} not found'})
        page.wait_for_timeout(1200)
        for v in page.evaluate('() => window.__csp || []'):
            found.append({'screen': name, **v})
        seen += 1
        if name == 'card':
            shot(page, 'csp-card')
    check(f'production build under the CloudFront CSP (script-src / style-src self): {seen} screens without CSP violations', not found, found[:20])
    ctx.close()


# The UI defaults to Japanese (09-i18n-and-visual.md §1.1, I1) whatever the browser language; the assertions of this test
# use the zh-CN source texts, so every context selects zh-CN the way a user would (the stored choice, atl.locale.v1).
UI_LOCALE_ZH = "try { if (!localStorage.getItem('atl.locale.v1')) localStorage.setItem('atl.locale.v1', JSON.stringify('zh-CN')); } catch (e) {}"

# ------------------------------------------------------------------------------------------------ main

def main() -> int:
    only = set(filter(None, args.only.split(',')))
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=not args.headed)
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='zh-CN', timezone_id='Asia/Tokyo')
        ctx.add_init_script(UI_LOCALE_ZH)
        ctx.set_default_timeout(20_000)
        page = ctx.new_page()
        attach(page, 'main')
        state['pump'] = page.wait_for_timeout
        flow = [
            ('login', lambda: phase_login(page)),
            ('catalog', lambda: phase_catalog(page)),
            ('start', lambda: state.update(sid=phase_start(page))),
            ('workbench', lambda: phase_workbench(page, state['sid'])),
            ('expire', lambda: phase_expire(page, state['sid'])),
            ('report', lambda: phase_report(page, state['sid'])),
            ('certificate', lambda: phase_certificate(page)),
            ('cleanup', lambda: phase_cleanup_failed(page)),
        ]
        for name, fn in flow:
            if only and name not in only and name != 'login':
                continue
            try:
                fn()
            except Abort as e:
                check(f'flow stopped: {e}', False)
                shot(page, f'fail-{name}', full=True)
                break
            except Exception as e:  # noqa: BLE001
                check(f'unexpected error in {name}: {type(e).__name__}: {str(e).splitlines()[0][:300]}', False, traceback.format_exc()[-1500:])
                shot(page, f'fail-{name}', full=True)
                break
        try:
            phase_screens(page)
        except Exception as e:  # noqa: BLE001
            check(f'screens: {type(e).__name__}: {e}', False)
        try:
            phase_csp(browser)
        except Exception as e:  # noqa: BLE001
            check(f'csp: {type(e).__name__}: {str(e).splitlines()[0][:300]}', False)
        state['phase'] = '10 console'
        # Chrome logs every failed fetch as a console error (“Failed to load resource … status of N”); those are judged by the
        # response itself: 5xx and 429 always fail, other 4xx only when not listed in EXPECTED_4XX
        http_events = [c for c in console_events if c['type'].startswith('http')]
        unexpected_http = [c for c in http_events if c['type'] >= 'http5' or c['type'] == 'http429' or not any(re.search(rx, c['text']) for st, rx in EXPECTED_4XX if c['type'] == f'http{st}')]
        other = [c for c in console_events if c['type'] in ('error', 'pageerror') and not re.match(r'Failed to load resource: the server responded with a status of', c['text'])]
        check('no console errors or page errors in the whole run', not other, other[:20])
        check('no unexpected HTTP errors (5xx, 429, unexpected 4xx)', not unexpected_http, unexpected_http[:20])
        browser.close()
    failed = [r for r in results if not r['ok']]
    summary = {
        'schema': 'atl.e2e-platform-results/v1',
        'sub': SUB,
        'sessionId': state.get('sid'),
        'failureSessionId': state.get('sid2'),
        'certId': state.get('certId'),
        'seconds': round(time.time() - T0),
        'passed': len(results) - len(failed),
        'failed': len(failed),
        'results': results,
        'console': console_events[-200:],
    }
    with open(os.path.join(OUT, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f'\ne2e:platform: {summary["passed"]} / {len(results)} passed in {summary["seconds"]}s' + (f' — FAILED: {"; ".join(r["name"] for r in failed)}' if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
