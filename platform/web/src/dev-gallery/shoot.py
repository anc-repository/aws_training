"""Headless self-check of the visual gallery (dev only).

Usage (with a Vite dev server for platform/web running, e.g. ATL_WEB_PORT=5197 npx vite):
    python platform/web/src/dev-gallery/shoot.py --base http://127.0.0.1:5197 --out <dir>

Takes full-page screenshots in light / dark at 1280px and light / dark at 400px (ja, plus en at 1280px),
and fails if the page scrolls horizontally at 400px or if the console reports errors.
Uses the system Chrome through Playwright (channel="chrome").
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

SHOTS = [
    ("light-1280-ja", "light", 1280, "ja"),
    ("dark-1280-ja", "dark", 1280, "ja"),
    ("light-1280-en", "light", 1280, "en"),
    ("light-400-ja", "light", 400, "ja"),
    ("dark-400-zh", "dark", 400, "zh-CN"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:5197")
    ap.add_argument("--out", required=True)
    ap.add_argument("--card", default=None)
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        for name, theme, width, lang in SHOTS:
            ctx = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=theme, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            # 资源加载失败按 URL 记录（浏览器自动请求的 /favicon.ico 不算）；控制台的同类消息不重复记录
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("response", lambda r: errors.append(f"{r.status} {r.url}") if r.status >= 400 and not r.url.endswith("/favicon.ico") else None)
            url = f"{args.base}/src/dev-gallery/?theme={theme}&lang={lang}"
            if args.card:
                url += f"&card={args.card}"
            page.goto(url, wait_until="networkidle")
            page.wait_for_selector("svg.arch-svg")
            metrics = page.evaluate(
                """() => ({
                  scrollWidth: document.documentElement.scrollWidth,
                  clientWidth: document.documentElement.clientWidth,
                  glyphs: document.querySelectorAll('.gal-glyphs li').length,
                  diagrams: document.querySelectorAll('svg.arch-svg').length,
                  lang: document.documentElement.lang,
                })"""
            )
            page.screenshot(path=str(out / f"{name}.png"), full_page=True)
            if metrics["scrollWidth"] > metrics["clientWidth"]:
                problems.append(f"{name}: horizontal page scroll {metrics['scrollWidth']} > {metrics['clientWidth']}")
            if metrics["glyphs"] != 40:
                problems.append(f"{name}: expected 40 glyph rows, got {metrics['glyphs']}")
            if errors:
                problems.append(f"{name}: console errors {errors[:3]}")
            print(name, json.dumps(metrics))
            ctx.close()
        # 放大看 16 / 24 / 48px 图标
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme="light", device_scale_factor=2)
        page = ctx.new_page()
        page.goto(f"{args.base}/src/dev-gallery/?theme=light&lang=ja", wait_until="networkidle")
        page.locator(".gal-group").first.screenshot(path=str(out / "glyphs-zoom-light.png"))
        page.goto(f"{args.base}/src/dev-gallery/?theme=dark&lang=ja", wait_until="networkidle")
        page.locator(".gal-group").nth(3).screenshot(path=str(out / "glyphs-zoom-dark.png"))
        ctx.close()
        browser.close()
    for msg in problems:
        print("PROBLEM:", msg)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
