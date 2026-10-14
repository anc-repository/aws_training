"""Browser end-to-end test of the ATL platform (npm run e2e:platform starts the servers and runs this file).

Python Playwright with the system Chrome (channel "chrome", headless). The SPA runs on Vite against the API dev server
(ATL_DEV_MODE=1, runner local-l0). Dev control endpoints (/__dev/*) stand in for what a test cannot do through the UI:
fast-forwarding the platform clock, the completion fixture of a learning path and the undeletable learner resource.

  python scripts/e2e/platform_e2e.py --web http://127.0.0.1:5174 --api http://127.0.0.1:8787 --out <dir> [--headed]

Languages (09-i18n-and-visual.md): the flow runs in zh-CN (its assertions use the source texts); phase 11 checks the
Japanese default, switching to English / Chinese, content per language with the “未翻訳” marker, the public verify page and
the main screens in ja / en (no horizontal scrolling, no clipped text), and writes Japanese screenshots of the main screens to
--ja-shots (.atl-dev/screens-ja/); phase 4c checks the live workbench in ja / en and switches the language there while the lab
terminal is connected (the terminal must stay connected: the UI re-renders in place).

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
# Japanese screenshots of the main screens (09-i18n-and-visual.md; default .atl-dev/screens-ja/ of this repository)
ap.add_argument('--ja-shots', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.atl-dev', 'screens-ja'))
args = ap.parse_args()

WEB = args.web.rstrip('/')
API = args.api.rstrip('/')
OUT = args.out
SHOTS = os.path.join(OUT, 'screenshots')
os.makedirs(SHOTS, exist_ok=True)
CSP_WEB = args.csp_web.rstrip('/')
JA_SHOTS = os.path.abspath(args.ja_shots) if args.ja_shots else ''
if JA_SHOTS:
    os.makedirs(JA_SHOTS, exist_ok=True)
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

def http(method: str, path: str, body: Any = None, token: str | None = LEARNER, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    url = f'{API}{path}'
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
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


OVERFLOWERS = """
() => {
  const W = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.right <= W + 1) continue;
    let p = el.parentElement, clipped = false;
    while (p) { const ox = getComputedStyle(p).overflowX; if (ox !== 'visible' && p.getBoundingClientRect().right <= W + 1) { clipped = true; break; } p = p.parentElement; }
    if (clipped) continue;
    const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    out.push(`${el.tagName.toLowerCase()}.${cls.split(' ').join('.')} right=${Math.round(r.right)} “${(el.textContent || '').trim().slice(0, 40)}”`);
  }
  return out.slice(0, 6);
}
"""


def overflowers(page: Page) -> list[str]:
    """The outermost elements that stick out of the viewport (diagnostics for a horizontal-scroll failure)."""
    try:
        return page.evaluate(OVERFLOWERS)
    except Exception as e:  # noqa: BLE001
        return [f'(not inspected: {e})']


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
    phase_ja_live(page.context.browser, sid)
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
    # ?lang= selects the language of the public page (09 §1.8); the Japanese overview screenshot of P09-V
    vp.goto(f'{WEB}/verify/{cert_id}?lang=ja')
    wait_until('verify result (?lang=ja)', lambda: res.get_attribute('data-result') not in (None, 'verifying'), 30, 0.5)
    check('verify page ?lang=ja: Japanese, same result', vp.evaluate('() => document.documentElement.lang') == 'ja' and res.get_attribute('data-result') == 'valid', vp.locator('#vh').inner_text())
    ja_shot(vp, '06-verify')
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
                bad.append(f'{name}: scrollWidth {m["scroll"]} > {m["client"]} {overflowers(page)}')
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


# ------------------------------------------------------------------------------------------------ languages (I1–I6)

# UI texts per language used by the language checks (platform/web/src/i18n/<lang>/*.ts)
LANG_TEXT: dict[str, dict[str, str]] = {
    'ja': {'catalog': 'カード一覧', 'learning': '学習状況', 'devSignIn': '開発用 ID でログイン', 'untranslated': '未翻訳', 'verifyTitle': 'ATL 修了証の検証'},
    'en': {'catalog': 'Card catalog', 'learning': 'My learning', 'devSignIn': 'Sign in as developer', 'untranslated': 'Not translated', 'verifyTitle': 'ATL certificate verification'},
    'zh-CN': {'catalog': '卡片目录', 'learning': '我的学习', 'devSignIn': '以开发身份登录', 'untranslated': '未翻译', 'verifyTitle': 'ATL 证书验证'},
}
KANA = re.compile(r'[぀-ヿ]')
HAN = re.compile(r'[一-鿿]')
LOCALE_KEY = 'atl.locale.v1'

# main screens checked in ja and en (zh-CN: phase 9 “screens”)
I18N_SCREENS = [
    ('catalog', '/labs?view=grid', '[data-screen=P02]'),
    ('catalog-map', '/labs?view=map', '[data-screen=P02]'),
    ('card', '/labs/svc-storage', '[data-screen=P03]'),
    ('track', '/tracks/quick-compare', '[data-screen=P02-T]'),
    # the workbench is checked while the session is live (phase 4c): after it ended the route shows no manual
    ('sessions', '/sessions', '[data-screen=P11]'),
    ('reclaim', '/sessions/{sid}/end', '[data-screen=P07]'),
    ('report', '/sessions/{sid}/report', '[data-screen=P08]'),
    ('manual', '/resources/manual', '[data-screen=P07-M]'),
    ('certificates', '/certificates', '[data-screen=P09]'),
    ('certificate', '/certificates/{certId}', '[data-screen=P09-C]'),
    ('learning', '/learning', '[data-screen=P10]'),
    ('settings', '/settings/profile', '[data-screen=P12]'),
    ('verify', '/verify/{certId}', '#vres'),
]


def html_lang(page: Page) -> str:
    return page.evaluate('() => document.documentElement.lang')


def stored_locale(page: Page) -> Any:
    return page.evaluate("k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return 'unreadable'; } }", LOCALE_KEY)


def ja_shot(page: Page, name: str, full: bool = True) -> None:
    """A screenshot for .atl-dev/screens-ja/ (Japanese UI, the overview of the main screens)."""
    if not JA_SHOTS:
        return
    try:
        page.screenshot(path=os.path.join(JA_SHOTS, f'{name}.png'), full_page=full)
    except Exception as e:  # noqa: BLE001
        log(f'ja screenshot {name} failed: {e}')


# diagnostics only: visible texts with characters used in simplified Chinese but not in Japanese (UI text that was not
# localized); content quoted from the CloudAlbum app or recorded in a report legitimately stays zh-CN
SIMPLIFIED_ONLY = '这们个为实验证书设认链务读运发应对开启动闭页还给从让说请吗么样过选择钮错误该仅确输账图标签视频访问显术载编辑预览删练习浏览复杂进态网络录记报价费结专题级别资额册续换签产轮询'
ZH_LEFTOVERS = """
(simp) => {
  const out = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (!t || !el || el.closest('script,style,noscript,code,pre,.mono,.xterm')) continue;
    if ([...t].some((c) => simp.includes(c))) out.add(t.slice(0, 60));
  }
  return [...out].slice(0, 8);
}
"""


# Text elements whose own text is wider than the element (and that do not scroll or truncate on purpose): clipped or
# overlapping labels. Inline elements, form controls, code, terminals, SVG and screen-reader-only text are skipped.
CLIPPED_TEXT = """
() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || !el.offsetParent || el.clientWidth === 0) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(el.tagName)) continue;
    if (el.closest('.xterm, svg, pre, code, .sr, .mono, [data-term-host]')) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.textOverflow === 'ellipsis' || cs.display === 'inline') continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own) continue;
    out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').join('.')} ${el.scrollWidth}>${el.clientWidth} “${own.slice(0, 30)}”`);
  }
  return out.slice(0, 8);
}
"""


# Errors of the test machine's network stack, not of the platform: Windows answers WSAENOBUFS (“No buffer space”) under
# heavy socket churn (Vite dev modules, HMR sockets, the dev server's local CloudAlbum). Listed in results.json, not failed.
ENV_NET_ERROR = re.compile(r'net::ERR_(NO_BUFFER_SPACE|INSUFFICIENT_RESOURCES)\b')


def is_app_error(c: dict[str, Any]) -> bool:
    return c['type'] in ('error', 'pageerror') and not re.match(r'Failed to load resource: the server responded with a status of', c['text']) and not ENV_NET_ERROR.search(c['text'])


def errors_since(mark: int, label: str) -> list[dict[str, Any]]:
    return [c for c in console_events[mark:] if c['page'] == label and is_app_error(c)]


def content_json(lang: str | None, rel: str, accept: str | None = None) -> tuple[dict[str, Any], Any]:
    """A content document through the catalog API: `?lang=` (or only Accept-Language when `lang` is None)."""
    q = f'?lang={lang}' if lang else ''
    code, cat = http('GET', f'/api/v1/catalog{q}', headers={'accept-language': accept} if accept else None)
    if code != 200:
        raise Abort(f'GET /api/v1/catalog{q} → {code}')
    base = cat['indexUrl'].rsplit('catalog/index.json', 1)[0]
    code, doc = http('GET', f'{base}{rel}', token=None)
    if code != 200:
        raise Abort(f'GET {base}{rel} → {code}')
    return cat, doc


def dev_login(page: Page, base: str = '') -> None:
    """Dev-token login through the form, whatever the UI language (selectors, not texts)."""
    page.goto(f'{base or WEB}/labs')
    page.wait_for_url(re.compile(r'/login\?next='))
    page.locator('[data-dev-login]').wait_for()
    page.locator('main select').first.select_option('learner')
    page.locator('input.mono').fill(SUB)
    page.locator('[data-dev-login] button[type=submit]').click()
    page.locator('[data-screen=P02]').wait_for(timeout=20_000)


def clipped_text(page: Page) -> list[str]:
    """Text elements whose content is wider than the element (cut off or overlapping a neighbour) — the per-element check
    the whole-page scroll test cannot see (translated labels are longer than the zh-CN ones they were sized for)."""
    try:
        return page.evaluate(CLIPPED_TEXT)
    except Exception as e:  # noqa: BLE001
        return [f'(not inspected: {e})']


def phase_ja_live(browser: Any, sid: str) -> None:
    """The live workbench (P05) in ja and en (a second browser context, as phase 4b): at 400 / 1280 px the manual step is
    rendered (not the loading skeleton), nothing scrolls sideways and no text is clipped; Japanese screenshot. Then the
    language is switched in the workbench's “more” menu while the lab terminal is connected: the switch happens in place —
    the terminal stays connected with its scrollback, the choice is stored and sent to the profile (PATCH /me)."""
    state['phase'] = '4c languages (live workbench)'
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='ja-JP', timezone_id='Asia/Tokyo')
    ctx.set_default_timeout(20_000)
    page = ctx.new_page()
    attach(page, 'ja-live')
    patches: list[str] = []
    page.on('request', lambda r: patches.append(r.post_data or '') if r.method == 'PATCH' and r.url.rstrip('/').endswith('/api/v1/me') else None)
    try:
        dev_login(page)
        bad: list[str] = []
        mark_at = len(console_events)
        for lang in ('ja', 'en'):
            page.evaluate("([k, l]) => localStorage.setItem(k, JSON.stringify(l))", [LOCALE_KEY, lang])
            for width in (400, 1280):
                page.set_viewport_size({'width': width, 'height': 900})
                page.goto(f'{WEB}/workspace/{sid}?step=orient')
                try:
                    page.locator('[data-screen=P05][data-variant=live] [data-step-heading]').first.wait_for(timeout=30_000)
                except Exception:  # noqa: BLE001
                    bad.append(f'{lang} {width}: manual step not rendered')
                    continue
                page.wait_for_timeout(1500)
                skel = page.locator('#mpane [data-skel]').count()
                if skel:
                    bad.append(f'{lang} {width}: {skel} skeleton line(s) left in the manual')
                if html_lang(page) != lang:
                    bad.append(f'{lang} {width}: <html lang> {html_lang(page)}')
                m = no_hscroll(page)
                if m['scroll'] > m['client'] + 1:
                    bad.append(f'{lang} {width}: scrollWidth {m["scroll"]} > {m["client"]} {overflowers(page)}')
                clip = clipped_text(page)
                if clip:
                    bad.append(f'{lang} {width}: clipped text {clip}')
                shot(page, f'{lang}-w{width}-workspace-live')
                if lang == 'ja' and width == 1280:
                    body = page.locator('body').inner_text()
                    check('ja: the live workbench (P05) renders in Japanese (UI and manual)', bool(KANA.search(body)) and page.locator('.untranslated').count() == 0, html_lang(page))
                    ja_shot(page, '04-workbench', full=False)
        check('live workbench (P05) in ja / en at 400 / 1280 px: the manual step (no skeleton), no horizontal scrolling, no clipped text', not bad, bad)
        errs = errors_since(mark_at, 'ja-live')
        check('live workbench in ja / en: no console errors', not errs, errs[:10])

        # --- switching the language inside the workbench keeps the terminal session (LocaleRoot re-renders in place)
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.evaluate("([k, l]) => localStorage.setItem(k, JSON.stringify(l))", [LOCALE_KEY, 'ja'])
        page.goto(f'{WEB}/workspace/{sid}?step=orient')
        page.locator('[data-screen=P05][data-variant=live] [data-step-heading]').first.wait_for(timeout=30_000)
        page.locator('#tab-terminal-lab').click()
        term = page.locator('[data-terminal=lab] .term:not([hidden])').first
        wait_until('lab terminal ready (ja)', lambda: term.get_attribute('data-phase') == 'ready', 45, 0.5)
        page.locator('[data-terminal=lab] .xterm').first.click()
        page.keyboard.type('echo atl-lang-switch')
        page.keyboard.press('Enter')
        wait_until('terminal output (ja)', lambda: (lambda t: t if t.count('atl-lang-switch') >= 2 else None)(page.locator('[data-terminal=lab] .xterm-rows').first.inner_text()), 20, 0.5)
        term_id = term.get_attribute('id')
        patches.clear()
        page.get_by_role('button', name='その他', exact=True).first.click()
        page.locator('.mi-group button[lang=en]').click()
        wait_until('UI in English', lambda: html_lang(page) == 'en' and 'Workbench' in page.locator('body').inner_text() or None, 15, 0.3)
        page.wait_for_timeout(2000)
        term2 = page.locator('[data-terminal=lab] .term:not([hidden])').first
        rows = page.locator('[data-terminal=lab] .xterm-rows').first.inner_text()
        detail = {'phase': term2.get_attribute('data-phase'), 'sameTab': term2.get_attribute('id') == term_id, 'scrollback': rows.count('atl-lang-switch'), 'lang': html_lang(page), 'stored': stored_locale(page), 'patchMe': patches[:2]}
        ok = detail['phase'] == 'ready' and detail['sameTab'] and detail['scrollback'] >= 2 and detail['lang'] == 'en' and detail['stored'] == 'en' and any('"en"' in p for p in patches)
        check('workbench “more” menu → English: switched in place — the lab terminal stays connected with its scrollback, the choice is stored and sent to the profile', ok, detail)
        # the terminal still works after the switch
        page.locator('[data-terminal=lab] .xterm').first.click()
        page.keyboard.type('echo atl-after-switch')
        page.keyboard.press('Enter')
        out = wait_until('terminal output (en)', lambda: (lambda t: t if t.count('atl-after-switch') >= 2 else None)(page.locator('[data-terminal=lab] .xterm-rows').first.inner_text()), 20, 0.5)
        check('the same terminal session answers after the language switch', out.count('atl-after-switch') >= 2, out[-160:])
    except Exception as e:  # noqa: BLE001 — recorded as a failure; the main flow goes on
        check(f'languages-live: {type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ""}', False, traceback.format_exc()[-1500:])
        shot(page, 'fail-languages-live', full=True)
    finally:
        ctx.close()


def phase_i18n(browser: Any) -> None:
    """Languages (09-i18n-and-visual.md, I1–I6): Japanese by default whatever the browser says, switching to English and
    Chinese (kept after a reload), content per language with the “未翻訳” marker where a translation is missing, the
    public verify page, and the main screens in ja / en at 400 / 1280 px without horizontal scrolling or console errors."""
    state['phase'] = '11 i18n'
    # a browser that prefers Chinese and has never chosen a language: the UI must still start in Japanese (I1)
    # (locale sets navigator.language and the browser's default Accept-Language; the SPA sends its own per request)
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='zh-CN', timezone_id='Asia/Tokyo')
    ctx.set_default_timeout(20_000)
    page = ctx.new_page()
    attach(page, 'i18n')
    try:
        # --- I1 default language
        page.goto(f'{WEB}/labs')
        page.wait_for_url(re.compile(r'/login\?next='))
        btn = page.locator('[data-dev-login] button[type=submit]')
        btn.wait_for()
        check('first visit (browser language zh-CN, nothing stored): the UI is Japanese', html_lang(page) == 'ja' and btn.inner_text().strip() == LANG_TEXT['ja']['devSignIn'] and stored_locale(page) is None, {'lang': html_lang(page), 'button': btn.inner_text(), 'stored': stored_locale(page)})
        dev_login(page)
        main = page.locator('[data-screen=P02]')
        page.get_by_role('heading', level=1, name=LANG_TEXT['ja']['catalog']).wait_for()
        page.locator('a[href="/labs/svc-storage"]').first.wait_for(timeout=15_000)
        ja_cat, ja_index = content_json('ja', 'catalog/index.json')
        storage = {lang: next(c for c in content_json(lang, 'catalog/index.json')[1]['cards'] if c['id'] == 'svc-storage') for lang in ('ja', 'en', 'zh-CN')}
        titles = {lang: c['title'] for lang, c in storage.items()}
        # a service card tile shows the service name and its function (the title is “service：function”)
        fns = {lang: c.get('function') or c['title'] for lang, c in storage.items()}
        tile = page.locator('article[data-card="svc-storage"]').first
        check('ja: catalog heading, navigation and card tiles in Japanese (content /ja/)', fns['ja'] in tile.inner_text() and LANG_TEXT['ja']['learning'] in page.locator('header').first.inner_text() and tile.locator('.untranslated').count() == 0, {'function': fns['ja'], 'tile': tile.inner_text()[:160]})
        ja_shot(page, '01-catalog-grid', full=False)
        # --- I1 switching (top bar), kept after a reload
        for lang in ('en', 'zh-CN'):
            page.locator('header .lang-switch select').first.select_option(lang)
            page.get_by_role('heading', level=1, name=LANG_TEXT[lang]['catalog']).wait_for(timeout=15_000)
            page.locator('a[href="/labs/svc-storage"]').first.wait_for(timeout=15_000)
            page.wait_for_timeout(800)
            body = page.locator('article[data-card="svc-storage"]').first.inner_text()
            ok = html_lang(page) == lang and fns[lang] in body and LANG_TEXT[lang]['learning'] in page.locator('header').first.inner_text() and stored_locale(page) == lang
            check(f'switch to {lang}: heading, navigation, card tiles and <html lang> follow; the choice is stored', ok, {'lang': html_lang(page), 'stored': stored_locale(page), 'function': fns[lang], 'tile': body[:160]})
            page.reload()
            page.get_by_role('heading', level=1, name=LANG_TEXT[lang]['catalog']).wait_for(timeout=20_000)
            check(f'{lang} is kept after a reload', html_lang(page) == lang, html_lang(page))
        page.locator('header .lang-switch select').first.select_option('ja')
        page.get_by_role('heading', level=1, name=LANG_TEXT['ja']['catalog']).wait_for(timeout=15_000)
        # --- I4 content per language (API) and the untranslated marker
        _, en_by_header = content_json(None, 'catalog/index.json', accept='en-US,en;q=0.9')
        _, zh_index = content_json('zh-CN', 'catalog/index.json')
        en_title = next(c['title'] for c in en_by_header['cards'] if c['id'] == 'svc-storage')
        check('catalog API: ?lang= and Accept-Language select the content language (ja kana / en ASCII / zh-CN Han)',
              ja_cat.get('contentLang') == 'ja' and bool(KANA.search(titles['ja'])) and en_title == titles['en'] and not HAN.search(titles['en']) and bool(HAN.search(titles['zh-CN'])) and not KANA.search(titles['zh-CN']) and 'i18n' not in zh_index,
              {'titles': titles, 'contentLang': ja_cat.get('contentLang')})
        startable = [c['id'] for c in ja_index['cards'] if c.get('status') != 'planned']
        meta_missing = [c['id'] for c in ja_index['cards'] if c.get('i18n', {}).get('fallback')]
        check(f'ja catalog index: metadata of all {len(ja_index["cards"])} cards translated (no fallback pointers)', not meta_missing and not ja_index.get('i18n', {}).get('fallback'), meta_missing[:10])
        with_fallback = None
        for cid in startable:
            intro = content_json('ja', f'catalog/cards/{cid}.json')[1]
            if intro.get('i18n', {}).get('fallback'):
                with_fallback = (cid, intro['i18n']['fallback'])
                break
        page.goto(f'{WEB}/labs/svc-storage')
        h1 = page.locator('[data-screen=P03] h1').first
        h1.wait_for()
        page.wait_for_timeout(1000)
        check('ja: translated card intro (svc-storage) has the Japanese title and no “未翻訳” marker', titles['ja'] in h1.inner_text() and page.locator('[data-screen=P03] h1 .untranslated').count() == 0, h1.inner_text()[:160])
        ja_shot(page, '03-card-intro')
        if with_fallback:
            cid, ptrs = with_fallback
            page.goto(f'{WEB}/labs/{cid}')
            mark = page.locator('[data-screen=P03] h1 .untranslated')
            mark.wait_for(timeout=15_000)
            check(f'ja: content shown from the fallback chain is marked “未翻訳” ({cid}: {", ".join(ptrs[:2])})', mark.inner_text().strip() == LANG_TEXT['ja']['untranslated'], mark.inner_text())
        else:
            # every intro is translated: drop the Japanese title of one on the wire, as an untranslated card would arrive
            zh_title = next(c['title'] for c in zh_index['cards'] if c['id'] == 'svc-storage')

            def strip(route: Any) -> None:
                r = route.fetch()
                doc = r.json()
                doc['title'] = zh_title
                doc['i18n'] = {'lang': 'ja', 'fallback': ['/title']}
                route.fulfill(response=r, json=doc)

            page.route('**/ja/catalog/cards/svc-storage.json', strip)
            page.goto(f'{WEB}/labs/svc-storage')
            mark = page.locator('[data-screen=P03] h1 .untranslated')
            mark.wait_for(timeout=15_000)
            check('ja: a field from the fallback chain is marked “未翻訳” (intro without its Japanese title)', mark.inner_text().strip() == LANG_TEXT['ja']['untranslated'], mark.inner_text())
            page.unroute('**/ja/catalog/cards/svc-storage.json')
        page.goto(f'{WEB}/labs?view=map')
        page.locator('[data-screen=P02]').wait_for()
        page.wait_for_timeout(1500)
        ja_shot(page, '02-service-map', full=False)
        if 'sid' in state:
            page.goto(f'{WEB}/sessions/{state["sid"]}/report')
            page.locator('[data-screen=P08]').wait_for(timeout=20_000)
            page.wait_for_timeout(1500)
            ja_shot(page, '05-report')
        # --- the public verify page: ja by default, language links switch
        if 'certId' in state:
            vctx = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='en-US', timezone_id='Asia/Tokyo')
            vp = vctx.new_page()
            attach(vp, 'i18n')
            vp.goto(f'{WEB}/verify/{state["certId"]}')
            res = vp.locator('#vres')
            wait_until('verify result (ja)', lambda: res.get_attribute('data-result') not in (None, 'verifying'), 30, 0.5)
            check('verify page: Japanese by default (browser en-US, nothing stored)', vp.locator('#vh').inner_text().strip() == LANG_TEXT['ja']['verifyTitle'] and html_lang(vp) == 'ja', {'h1': vp.locator('#vh').inner_text(), 'lang': html_lang(vp)})
            for lang in ('en', 'zh-CN'):
                vp.locator(f'#vlang a[data-lang="{lang}"]').click()
                vp.wait_for_url(re.compile(rf'lang={re.escape(lang)}'))
                wait_until(f'verify result ({lang})', lambda: res.get_attribute('data-result') not in (None, 'verifying'), 30, 0.5)
                cur = vp.locator('#vlang a[aria-current=true]').get_attribute('data-lang')
                check(f'verify page: the {lang} link switches it (title, <html lang>, current link; same result)', vp.locator('#vh').inner_text().strip() == LANG_TEXT[lang]['verifyTitle'] and html_lang(vp) == lang and cur == lang and res.get_attribute('data-result') == 'revoked', {'h1': vp.locator('#vh').inner_text(), 'lang': html_lang(vp), 'current': cur, 'result': res.get_attribute('data-result')})
            vctx.close()
        # --- main screens in ja and en: 400 / 1280 px, no horizontal scrolling, no console errors. On the production build
        # under the CloudFront CSP when it runs (bundled: a few requests per screen instead of the dev server's hundreds of
        # modules, and the CSP is checked in both languages too); its origin has its own storage, so sign in there first
        base = CSP_WEB or WEB
        if CSP_WEB:
            page.close()
            page = ctx.new_page()
            attach(page, 'i18n')
            page.add_init_script(CSP_PROBE)
            dev_login(page, CSP_WEB)
        build = 'production build, CSP' if CSP_WEB else 'dev server'
        for lang in ('ja', 'en'):
            page.evaluate("([k, l]) => localStorage.setItem(k, JSON.stringify(l))", [LOCALE_KEY, lang])
            mark_at = len(console_events)
            violations: list[dict[str, Any]] = []
            for width in (400, 1280):
                page.set_viewport_size({'width': width, 'height': 900})
                bad = []
                seen = 0
                for name, path, sel in I18N_SCREENS:
                    if ('{sid}' in path and 'sid' not in state) or ('{certId}' in path and 'certId' not in state):
                        continue
                    page.goto(f'{base}{path.format(sid=state.get("sid"), certId=state.get("certId"))}')
                    try:
                        page.locator(sel).first.wait_for(timeout=20_000)
                    except Exception:  # noqa: BLE001
                        bad.append(f'{name}: {sel} not found')
                    page.wait_for_timeout(1000)
                    seen += 1
                    if html_lang(page) != lang:
                        bad.append(f'{name}: <html lang> {html_lang(page)}')
                    m = no_hscroll(page)
                    if m['scroll'] > m['client'] + 1:
                        bad.append(f'{name}: scrollWidth {m["scroll"]} > {m["client"]} {overflowers(page)}')
                    clip = clipped_text(page)
                    if clip:
                        bad.append(f'{name}: clipped text {clip}')
                    shot(page, f'{lang}-w{width}-{name}', full=True)
                    if width == 1280:
                        left = page.evaluate(ZH_LEFTOVERS, SIMPLIFIED_ONLY)
                        if left:
                            log(f'{lang} {name}: zh-CN text on the page (review): {left}')
                    if name != 'verify':  # P09-V has its own CSP (atl-certs), not the SPA's
                        violations += [{'screen': name, **v} for v in page.evaluate('() => window.__csp || []')]
                check(f'{lang} {width}px: {seen} main screens in {lang} ({build}), no horizontal scrolling, no clipped text', not bad, bad)
            errs = errors_since(mark_at, 'i18n')
            check(f'{lang}: no console errors on the main screens', not errs, errs[:10])
            if CSP_WEB:
                check(f'{lang}: no CSP violations on the main screens (style-src / script-src self)', not violations, violations[:10])
        page.set_viewport_size({'width': 1280, 'height': 900})
    except Abort as e:
        check(f'i18n stopped: {e}', False)
        shot(page, 'fail-i18n', full=True)
    except Exception as e:  # noqa: BLE001
        check(f'i18n: {type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ""}', False, traceback.format_exc()[-1500:])
        shot(page, 'fail-i18n', full=True)
    finally:
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
        mark_at = len(console_events)
        try:
            phase_screens(page)
        except Exception as e:  # noqa: BLE001
            check(f'screens: {type(e).__name__}: {e}', False)
        errs = errors_since(mark_at, 'main')
        check('zh-CN: no console errors on the main screens', not errs, errs[:10])
        try:
            phase_csp(browser)
        except Exception as e:  # noqa: BLE001
            check(f'csp: {type(e).__name__}: {str(e).splitlines()[0][:300]}', False)
        phase_i18n(browser)
        state['phase'] = '10 console'
        # Chrome logs every failed fetch as a console error (“Failed to load resource … status of N”); those are judged by the
        # response itself: 5xx and 429 always fail, other 4xx only when not listed in EXPECTED_4XX
        http_events = [c for c in console_events if c['type'].startswith('http')]
        unexpected_http = [c for c in http_events if c['type'] >= 'http5' or c['type'] == 'http429' or not any(re.search(rx, c['text']) for st, rx in EXPECTED_4XX if c['type'] == f'http{st}')]
        other = [c for c in console_events if is_app_error(c)]
        env_errors = [c for c in console_events if c['type'] in ('error', 'pageerror') and ENV_NET_ERROR.search(c['text'])]
        if env_errors:
            log(f'{len(env_errors)} network error(s) of the test machine (not counted): {env_errors[:3]}')
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
        'environmentNetworkErrors': [c for c in console_events if ENV_NET_ERROR.search(c['text'])][:50],
    }
    with open(os.path.join(OUT, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f'\ne2e:platform: {summary["passed"]} / {len(results)} passed in {summary["seconds"]}s' + (f' — FAILED: {"; ".join(r["name"] for r in failed)}' if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
