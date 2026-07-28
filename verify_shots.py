import sys, pathlib
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(sys.argv[1])
URL = sys.argv[2]
OUT.mkdir(parents=True, exist_ok=True)


def launch(p):
    for kw in ({}, {"channel": "chrome"}, {"channel": "msedge"}):
        try:
            return p.chromium.launch(headless=True, **kw)
        except Exception as e:
            print("launch fail", kw, str(e)[:80])
    raise SystemExit("no browser available")


def to_form(page):
    """進場頁 → 表單頁：快速使用(不登入) → (可能出現)直接進入"""
    page.click("text=快速使用（不登入）")
    page.wait_for_timeout(600)
    btn = page.locator("#hlEnterBuiltin")
    if btn.is_visible():
        btn.click()
        page.wait_for_timeout(800)


with sync_playwright() as p:
    b = launch(p)

    # 1. 進場頁 桌機 淺色
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.goto(URL, wait_until="load")
    pg.wait_for_timeout(1200)
    pg.screenshot(path=OUT / "1-splash-desktop.png")
    # 身分徽章區域特寫
    try:
        pg.locator(".hl-identity-grid").screenshot(path=OUT / "2-identity-grid.png")
    except Exception as e:
        print("grid shot fail:", str(e)[:120])
    # hover 反白效果
    try:
        pg.locator(".hl-identity-btn.role-teacher").hover()
        pg.wait_for_timeout(400)
        pg.locator(".hl-identity-grid").screenshot(path=OUT / "3-identity-hover.png")
    except Exception as e:
        print("hover shot fail:", str(e)[:120])
    # 表單頁 banner
    try:
        to_form(pg)
        pg.screenshot(path=OUT / "4-form-desktop.png")
        pg.locator(".lq-hero-visual").screenshot(path=OUT / "5-hero-visual.png")
    except Exception as e:
        print("form shot fail:", str(e)[:200])
    pg.close()

    # 2. 深色模式
    pg = b.new_page(viewport={"width": 1280, "height": 900}, color_scheme="dark")
    pg.goto(URL, wait_until="load")
    pg.wait_for_timeout(1000)
    pg.screenshot(path=OUT / "6-splash-dark.png")
    try:
        to_form(pg)
        pg.locator(".lq-hero-visual").screenshot(path=OUT / "7-hero-dark.png")
    except Exception as e:
        print("dark form fail:", str(e)[:200])
    pg.close()

    # 3. 手機版
    pg = b.new_page(viewport={"width": 390, "height": 844})
    pg.goto(URL, wait_until="load")
    pg.wait_for_timeout(1000)
    pg.screenshot(path=OUT / "8-splash-mobile.png")
    try:
        to_form(pg)
        pg.locator(".lq-hero-visual").screenshot(path=OUT / "9-hero-mobile.png")
    except Exception as e:
        print("mobile form fail:", str(e)[:200])
    pg.close()

    b.close()

print("OK", [f.name for f in sorted(OUT.glob("*.png"))])
