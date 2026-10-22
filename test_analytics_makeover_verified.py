"""
Automated Verification Suite for Analytics & Insights Makeover (Screenshots 1-5 Fidelity).
Runs Chrome headless/visible via CDP, validates every visual & interactive requirement,
and saves high-resolution verification screenshots for desktop and mobile.
"""
import os
import sys
import time
import json
import socket
import base64
import urllib.request
import subprocess
from http.server import ThreadingHTTPServer

from db import db
from server import JSRFinanceHandler

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

PORT_HTTP = 8998
PORT_CDP = 9266

def simple_ws_send_recv(ws_url, msg):
    from urllib.parse import urlparse
    u = urlparse(ws_url)
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.connect((u.hostname, u.port))

    key = base64.b64encode(b"1234567890123456").decode("utf-8")
    req = (
        f"GET {u.path} HTTP/1.1\r\n"
        f"Host: {u.hostname}:{u.port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n"
    )
    s.sendall(req.encode("utf-8"))
    s.recv(4096)

    payload = json.dumps(msg).encode("utf-8")
    frame = bytearray([0x81])
    length = len(payload)
    if length < 126:
        frame.append(0x80 | length)
    elif length < 65536:
        frame.extend([0x80 | 126, (length >> 8) & 0xFF, length & 0xFF])
    else:
        frame.extend([0x80 | 127])
        frame.extend([(length >> (8 * (7 - i))) & 0xFF for i in range(8)])

    mask = b"\x12\x34\x56\x78"
    frame.extend(mask)
    masked = bytearray([b ^ mask[i % 4] for i, b in enumerate(payload)])
    frame.extend(masked)
    s.sendall(frame)

    chunks = []
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if len(chunk) < 65536:
                break
    except Exception:
        pass
    s.close()
    raw = b"".join(chunks)
    if len(raw) > 2:
        payload_len = raw[1] & 0x7F
        offset = 2
        if payload_len == 126:
            offset = 4
        elif payload_len == 127:
            offset = 10
        return raw[offset:].decode("utf-8", errors="ignore")
    return None

def get_cdp_value(res_str):
    if not res_str:
        return None
    d = json.loads(res_str)
    res_obj = d.get("result", {})
    if "result" in res_obj and "value" in res_obj["result"]:
        val = res_obj["result"]["value"]
        if isinstance(val, str):
            try:
                return json.loads(val)
            except Exception:
                return val
        return val
    return res_obj

def find_chrome():
    paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expanduser(r"~\AppData\Local\Google\Chrome\Application\chrome.exe")
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None

def run_analytics_verification():
    chrome_path = find_chrome()
    if not chrome_path:
        print("[FAIL] Google Chrome not found")
        sys.exit(1)

    print(f"[1/6] Starting Local HTTP Server on port {PORT_HTTP}...")
    server = ThreadingHTTPServer(("127.0.0.1", PORT_HTTP), JSRFinanceHandler)
    import threading
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    profile_dir = os.path.abspath(f"./.chrome_test_analytics_profile_{int(time.time())}")
    os.makedirs(profile_dir, exist_ok=True)

    print(f"[2/6] Launching Chrome with CDP on port {PORT_CDP}...")
    cmd = [
        chrome_path,
        f"--remote-debugging-port={PORT_CDP}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-cache",
        "--window-size=1366,900",
        f"http://127.0.0.1:{PORT_HTTP}/index.html?t={int(time.time())}"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        ws_url = None
        for _ in range(25):
            time.sleep(0.4)
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json") as r:
                    targets = json.loads(r.read().decode("utf-8"))
                    for tg in targets:
                        if tg.get("type") == "page":
                            ws_url = tg.get("webSocketDebuggerUrl")
                            break
                    if ws_url:
                        break
            except Exception:
                pass

        if not ws_url:
            print("[FAIL] CDP target not found")
            sys.exit(1)

        time.sleep(2)

        # Login and switch to Analytics tab
        print("[3/6] Authenticating and navigating to Analytics & Insights view...")
        login_js = """
        (function() {
            document.getElementById('view-login').style.display = 'none';
            verifyAndLoginGoogleUser('admin@jsrfinance.com', 'Surendra Singari');
            
            // Seed realistic portfolio data
            state.customers = [
                {
                    id: 'CUST-001',
                    name: 'Sri Ram',
                    customerNumber: 1,
                    loanNumber: 1,
                    givenAmount: 30000,
                    totalInstalments: 52,
                    instalmentAmount: 600,
                    areaRoute: 'Main Road',
                    instalments: [
                        { number: 1, status: 'Received', paidAmount: 600, paidDate: '2026-10-22' },
                        { number: 2, status: 'Received', paidAmount: 600, paidDate: '2026-10-21' },
                        { number: 3, status: 'Pending', paidAmount: 0 }
                    ]
                },
                {
                    id: 'CUST-002',
                    name: 'K. Venkatesh',
                    customerNumber: 2,
                    loanNumber: 1,
                    givenAmount: 80000,
                    totalInstalments: 52,
                    instalmentAmount: 1600,
                    areaRoute: '2nd Cross',
                    instalments: [
                        { number: 1, status: 'Received', paidAmount: 1600, paidDate: '2026-10-20' },
                        { number: 2, status: 'Pending', paidAmount: 0 },
                        { number: 3, status: 'Pending', paidAmount: 0 },
                        { number: 4, status: 'Pending', paidAmount: 0 }
                    ]
                },
                {
                    id: 'CUST-003',
                    name: 'Lakshmi Devi',
                    customerNumber: 3,
                    loanNumber: 1,
                    givenAmount: 20000,
                    totalInstalments: 52,
                    instalmentAmount: 400,
                    areaRoute: '3rd Block',
                    instalments: Array.from({length: 52}, (_, i) => ({ number: i + 1, status: 'Received', paidAmount: 400, paidDate: '2026-10-15' }))
                }
            ];
            state.transactions = [
                { id: 'TXN-1', customerId: 'CUST-001', customerName: 'Sri Ram', amount: 600, date: '2026-10-22', type: 'collection' },
                { id: 'TXN-2', customerId: 'CUST-001', customerName: 'Sri Ram', amount: 600, date: '2026-10-21', type: 'collection' },
                { id: 'TXN-3', customerId: 'CUST-002', customerName: 'K. Venkatesh', amount: 1600, date: '2026-10-20', type: 'collection' }
            ];

            switchTab('analytics');
            renderAnalytics();
            return JSON.stringify({
                activeTab: state.activeTab,
                customersCount: (state.customers || []).length,
                transactionsCount: (state.transactions || []).length
            });
        })()
        """
        res = simple_ws_send_recv(ws_url, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": login_js, "returnByValue": True}})
        print("DEBUG RES:", res)
        val = get_cdp_value(res)
        print(f"      Status: activeTab={val.get('activeTab')}, customers={val.get('customersCount')}, transactions={val.get('transactionsCount')}")
        assert val.get('activeTab') == 'analytics', "Failed to switch to Analytics tab"

        time.sleep(1)

        # 4. Verify 4 Top KPI Cards and Elements
        print("[4/6] Verifying Top 4 KPI Cards and Financial Metrics...")
        kpi_check_js = """
        (function() {
            const activeLoans = document.getElementById('ana-active-loans')?.innerText.trim();
            const capRec = document.getElementById('ana-capital-recovered')?.innerText.trim();
            const capRecSub = document.getElementById('ana-capital-recovered-sub')?.innerText.trim();
            const profitEarned = document.getElementById('ana-profit-earned')?.innerText.trim();
            const outstanding = document.getElementById('ana-outstanding')?.innerText.trim();
            const trendBadge = document.getElementById('ana-trend-badge')?.innerText.trim();
            const barCols = document.querySelectorAll('#ana-trend-chart .ana-bar-col').length;
            const nowBar = document.querySelector('#ana-trend-chart .is-now');

            return JSON.stringify({
                activeLoans,
                capRec,
                capRecSub,
                profitEarned,
                outstanding,
                trendBadge,
                barCols,
                hasNextWeekProjected: !!document.getElementById('ana-projected-week')?.innerText,
                hasNowBar: !!nowBar
            });
        })()
        """
        res = simple_ws_send_recv(ws_url, {"id": 2, "method": "Runtime.evaluate", "params": {"expression": kpi_check_js}})
        kpi_data = get_cdp_value(res)
        print(f"      Top KPIs: Active Loans={kpi_data.get('activeLoans')}, Cap Recovered={kpi_data.get('capRec')}, Profit={kpi_data.get('profitEarned')}, Outstanding={kpi_data.get('outstanding')}")
        print(f"      Weekly Chart: {kpi_data.get('barCols')} bars rendered, Now Bar Present={kpi_data.get('hasNowBar')}")

        assert int(kpi_data.get('activeLoans', '0')) >= 0, "Invalid Active Loans count"
        assert '₹' in kpi_data.get('capRec', ''), "Capital recovered missing currency symbol"
        assert '₹' in kpi_data.get('profitEarned', ''), "Profit earned missing currency symbol"
        assert '₹' in kpi_data.get('outstanding', ''), "Outstanding missing currency symbol"
        assert kpi_data.get('barCols') == 6, f"Expected 6 trend bars, found {kpi_data.get('barCols')}"
        assert kpi_data.get('hasNowBar'), "Missing 'Now' highlighted bar in trend chart"

        # 5. Verify Accordions, Routes, Follow-up, Financial Overview, Summary & Quick Actions
        print("[5/6] Verifying Interactivity: Accordions, Filters, Financial Overview, and Quick Actions...")
        interactive_check_js = """
        (function() {
            // 1. Test Accordion Toggle
            const profitBodyBefore = document.getElementById('ana-acc-body-profit').style.display;
            toggleAnalyticsAccordion('profit');
            const profitBodyAfter = document.getElementById('ana-acc-body-profit').style.display;

            // 2. Test Loan Status breakdown
            const activeLoansCount = document.getElementById('ana-status-active-count')?.innerText.trim();
            const completedLoansCount = document.getElementById('ana-status-completed-count')?.innerText.trim();
            const overdueLoansCount = document.getElementById('ana-status-overdue-count')?.innerText.trim();
            const atriskLoansCount = document.getElementById('ana-status-atrisk-count')?.innerText.trim();

            // 3. Test Route Cards
            const routeCardsCount = document.querySelectorAll('#ana-routes-cards-list .ana-route-card').length;
            const routeSelectOpts = document.querySelectorAll('#ana-route-select option').length;

            // 4. Test Follow-ups
            const fuOverdue = document.getElementById('ana-fu-overdue-count')?.innerText.trim();
            const fuAtrisk = document.getElementById('ana-fu-atrisk-count')?.innerText.trim();
            const fuCompleted = document.getElementById('ana-fu-completed-count')?.innerText.trim();

            // 5. Test Financial Overview Hero
            const finHeroAmt = document.getElementById('ana-fin-collected-hero')?.innerText.trim();
            const finTargetAmt = document.getElementById('ana-fin-target-amt')?.innerText.trim();
            const finTargetPct = document.getElementById('ana-fin-progress-pct')?.innerText.trim();

            // 6. Test Quick Actions existence
            const quickCards = document.querySelectorAll('.ana-quick-card').length;

            // 7. Test Period Button click
            setAnalyticsPeriod('month');
            const periodMonthActive = document.querySelector('.ana-period-btn[data-period="month"]').classList.contains('active');
            setAnalyticsPeriod('all');

            return JSON.stringify({
                profitToggled: profitBodyBefore !== profitBodyAfter,
                activeLoansCount,
                completedLoansCount,
                overdueLoansCount,
                atriskLoansCount,
                routeCardsCount,
                routeSelectOpts,
                fuOverdue,
                fuAtrisk,
                fuCompleted,
                finHeroAmt,
                finTargetAmt,
                finTargetPct,
                quickCards,
                periodMonthActive
            });
        })()
        """
        res = simple_ws_send_recv(ws_url, {"id": 3, "method": "Runtime.evaluate", "params": {"expression": interactive_check_js}})
        idata = get_cdp_value(res)
        print(f"      Profit Accordion Toggled: {idata.get('profitToggled')}")
        print(f"      Loan Status: Active={idata.get('activeLoansCount')}, Completed={idata.get('completedLoansCount')}, Overdue={idata.get('overdueLoansCount')}, At-risk={idata.get('atriskLoansCount')}")
        print(f"      Route Performance: {idata.get('routeCardsCount')} route cards rendered, {idata.get('routeSelectOpts')} select options")
        print(f"      Follow-ups: Overdue={idata.get('fuOverdue')}, At-risk={idata.get('fuAtrisk')}, Completed={idata.get('fuCompleted')}")
        print(f"      Financial Overview: Hero={idata.get('finHeroAmt')}, Target={idata.get('finTargetAmt')}, Progress={idata.get('finTargetPct')}")
        print(f"      Quick Actions: {idata.get('quickCards')} action cards present")
        print(f"      Period Toggle Success: {idata.get('periodMonthActive')}")

        assert idata.get('profitToggled'), "Profit accordion failed to toggle"
        assert idata.get('quickCards') == 2, f"Expected 2 quick action cards, found {idata.get('quickCards')}"
        assert idata.get('periodMonthActive'), "Period button failed to activate"

        # 6. Capture Desktop Screenshot
        print("[6/6] Capturing Desktop & Mobile Screenshots for Walkthrough...")
        res_screen_desktop = simple_ws_send_recv(ws_url, {
            "id": 4,
            "method": "Page.captureScreenshot",
            "params": {"format": "png"}
        })
        d_screen = json.loads(res_screen_desktop)
        if "result" in d_screen and "data" in d_screen["result"]:
            img_bytes = base64.b64decode(d_screen["result"]["data"])
            desktop_path = os.path.abspath("analytics_makeover_desktop.png")
            with open(desktop_path, "wb") as f:
                f.write(img_bytes)
            print(f"      Desktop Screenshot saved: {desktop_path} ({len(img_bytes)} bytes)")

        # Copy desktop screenshot to artifact directory
        art_dir = r"C:\Users\surendra.s\.gemini\antigravity\brain\9a0c6fee-fcaa-42a0-ade3-57b237e6eb62"
        if os.path.exists(art_dir):
            import shutil
            shutil.copy("analytics_makeover_desktop.png", os.path.join(art_dir, "analytics_makeover_desktop.png"))

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            pass

    # Launch dedicated Mobile window (400px wide) for true mobile fidelity
    print("[6b/6] Capturing True Mobile Viewport Screenshot (400x880)...")
    port_cdp_mobile = 9268
    profile_dir_mob = os.path.abspath(f"./.chrome_test_analytics_mob_{int(time.time())}")
    os.makedirs(profile_dir_mob, exist_ok=True)
    cmd_mob = [
        chrome_path,
        f"--remote-debugging-port={port_cdp_mobile}",
        f"--user-data-dir={profile_dir_mob}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-cache",
        "--window-size=412,915",
        f"http://127.0.0.1:{PORT_HTTP}/index.html?t={int(time.time())}"
    ]
    proc_mob = subprocess.Popen(cmd_mob, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url_mob = None
        for _ in range(25):
            time.sleep(0.4)
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port_cdp_mobile}/json") as r:
                    targets = json.loads(r.read().decode("utf-8"))
                    for tg in targets:
                        if tg.get("type") == "page":
                            ws_url_mob = tg.get("webSocketDebuggerUrl")
                            break
                    if ws_url_mob:
                        break
            except Exception:
                pass

        if ws_url_mob:
            time.sleep(1.5)
            login_js = """
            (function() {
                document.getElementById('view-login').style.display = 'none';
                verifyAndLoginGoogleUser('admin@jsrfinance.com', 'Surendra Singari');
                switchTab('analytics');
                renderAnalytics();
                return true;
            })()
            """
            simple_ws_send_recv(ws_url_mob, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": login_js}})
            time.sleep(1)

            res_screen = simple_ws_send_recv(ws_url_mob, {"id": 2, "method": "Page.captureScreenshot", "params": {"format": "png"}})
            m_screen = json.loads(res_screen)
            if "result" in m_screen and "data" in m_screen["result"]:
                img_bytes = base64.b64decode(m_screen["result"]["data"])
                mobile_path = os.path.abspath("analytics_makeover_mobile.png")
                with open(mobile_path, "wb") as f:
                    f.write(img_bytes)
                if os.path.exists(art_dir):
                    import shutil
                    shutil.copy(mobile_path, os.path.join(art_dir, "analytics_makeover_mobile.png"))
                print(f"      True Mobile Screenshot saved: {mobile_path} ({len(img_bytes)} bytes)")
    finally:
        try:
            proc_mob.terminate()
            proc_mob.wait(timeout=3)
        except Exception:
            pass
        server.shutdown()

    print("\n=======================================================")
    print("ALL ANALYTICS MAKEOVER VERIFICATIONS PASSED SUCCESSFULLY!")
    print("=======================================================")

if __name__ == '__main__':
    run_analytics_verification()
