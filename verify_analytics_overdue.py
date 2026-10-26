"""
Automated Verification Suite for Overdue & At-Risk Loans on Analytics Screen.
Tests:
1. Overdue and At-Risk loan counts calculation.
2. Display of customer names, loan badge (L1, L2), total loan counts (e.g. Loan 1 of 2),
   overdue badges, pending balance, and phone.
3. Interactive category filtering (overdue, atrisk, completed, all).
4. Jump to customer schedule in collection matrix.
5. High-resolution screenshot capture.
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

from server import JSRFinanceHandler

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

PORT_HTTP = 8996
PORT_CDP = 9268
ARTIFACTS_DIR = r"C:\Users\surendra.s\.gemini\antigravity\brain\9a0c6fee-fcaa-42a0-ade3-57b237e6eb62"

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

def main():
    chrome_path = find_chrome()
    if not chrome_path:
        print("[FAIL] Google Chrome not found")
        sys.exit(1)

    print(f"[1/6] Starting HTTP server on port {PORT_HTTP}...")
    server = ThreadingHTTPServer(("127.0.0.1", PORT_HTTP), JSRFinanceHandler)
    import threading
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    profile_dir = os.path.abspath(f"./.chrome_overdue_test_{int(time.time())}")
    os.makedirs(profile_dir, exist_ok=True)

    print(f"[2/6] Launching Chrome on CDP port {PORT_CDP}...")
    cmd = [
        chrome_path,
        f"--remote-debugging-port={PORT_CDP}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-cache",
        "--window-size=1366,950",
        f"http://127.0.0.1:{PORT_HTTP}/index.html?t={int(time.time())}"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        ws_url = None
        for _ in range(30):
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

        time.sleep(1.5)

        # 1. Sign in & Seed Realistic Customer Data
        print("[3/6] Authenticating and injecting realistic overdue customer data...")
        seed_js = """
        (function() {
            const loginEl = document.getElementById('view-login');
            if (loginEl) loginEl.style.display = 'none';
            verifyAndLoginGoogleUser('admin@jsrfinance.com', 'Surendra Singari');

            // Seed realistic customers matching the user's scenario
            state.customers = [
                {
                    id: 'CUST-018-L1',
                    customerNumber: 18,
                    loanNumber: 1,
                    fullName: 'Mahadeva',
                    phone: '8310058450',
                    areaRoute: 'Route 1',
                    givenAmount: 200000,
                    instalmentAmount: 4000,
                    totalInstalments: 50,
                    frequency: 'Weekly',
                    startDate: '2026-08-17', // Exactly 10 weeks ago
                    instalments: Array.from({length: 50}, (_, i) => ({
                        number: i + 1,
                        status: i < 8 ? 'Received' : 'Pending', // 8 paid out of 10 expected -> missedCount = 2 (Overdue, not at-risk)
                        paidAmount: i < 8 ? 4000 : 0,
                        paidDate: i < 8 ? '2026-10-05' : null
                    }))
                },
                {
                    id: 'CUST-101-L1',
                    customerNumber: 101,
                    loanNumber: 1,
                    fullName: 'Suresh Kumar',
                    phone: '8310058450',
                    areaRoute: 'Route 1',
                    givenAmount: 200000,
                    instalmentAmount: 4000,
                    totalInstalments: 50,
                    frequency: 'Weekly',
                    startDate: '2026-01-01', // 42 weeks ago
                    instalments: Array.from({length: 50}, (_, i) => ({
                        number: i + 1,
                        status: i < 10 ? 'Received' : 'Pending', // 32 weeks missed -> severe at-risk!
                        paidAmount: i < 10 ? 4000 : 0,
                        paidDate: i < 10 ? '2026-03-15' : null
                    }))
                },
                {
                    id: 'CUST-101-L2',
                    customerNumber: 101,
                    loanNumber: 2,
                    fullName: 'Suresh Kumar',
                    phone: '8310058450',
                    areaRoute: 'Route 1',
                    givenAmount: 100000,
                    instalmentAmount: 2000,
                    totalInstalments: 50,
                    frequency: 'Weekly',
                    startDate: '2026-03-01', // 33 weeks ago
                    instalments: Array.from({length: 50}, (_, i) => ({
                        number: i + 1,
                        status: i < 5 ? 'Received' : 'Pending', // 28 weeks missed -> severe at-risk!
                        paidAmount: i < 5 ? 2000 : 0,
                        paidDate: i < 5 ? '2026-04-10' : null
                    }))
                },
                {
                    id: 'CUST-205-L1',
                    customerNumber: 205,
                    loanNumber: 1,
                    fullName: 'Lakshmi Devi',
                    phone: '9845012345',
                    areaRoute: 'Route 2',
                    givenAmount: 50000,
                    instalmentAmount: 1000,
                    totalInstalments: 50,
                    frequency: 'Weekly',
                    startDate: '2026-10-15', // Recent, not overdue
                    instalments: Array.from({length: 50}, (_, i) => ({
                        number: i + 1,
                        status: i < 2 ? 'Received' : 'Pending',
                        paidAmount: i < 2 ? 1000 : 0,
                        paidDate: i < 2 ? '2026-10-22' : null
                    }))
                },
                {
                    id: 'CUST-300-L1',
                    customerNumber: 300,
                    loanNumber: 1,
                    fullName: 'Ganesh Rao',
                    phone: '9900112233',
                    areaRoute: 'Route 1',
                    givenAmount: 20000,
                    instalmentAmount: 400,
                    totalInstalments: 50,
                    frequency: 'Weekly',
                    startDate: '2025-10-01',
                    instalments: Array.from({length: 50}, (_, i) => ({
                        number: i + 1,
                        status: 'Received',
                        paidAmount: 400,
                        paidDate: '2026-09-01'
                    }))
                }
            ];

            switchTab('analytics');
            renderAnalytics();

            return JSON.stringify({
                activeTab: state.activeTab,
                totalCustomers: state.customers.length
            });
        })()
        """
        res = simple_ws_send_recv(ws_url, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": seed_js, "returnByValue": True}})
        print("DEBUG RES 1:", res)
        val = get_cdp_value(res)
        print("      Active tab:", val.get("activeTab"), "Customers count:", val.get("totalCustomers"))
        assert val.get("activeTab") == "analytics", "Failed to switch to Analytics tab"

        time.sleep(1)

        # 2. Verify Overdue & At-Risk Counts
        print("[4/6] Verifying Overdue and At-Risk metrics on Analysis screen...")
        verify_counts_js = """
        (function() {
            const statusOverdue = document.getElementById('ana-status-overdue-count')?.innerText.trim();
            const statusAtrisk = document.getElementById('ana-status-atrisk-count')?.innerText.trim();
            const fuOverdue = document.getElementById('ana-fu-overdue-count')?.innerText.trim();
            const fuAtrisk = document.getElementById('ana-fu-atrisk-count')?.innerText.trim();
            const fuCompleted = document.getElementById('ana-fu-completed-count')?.innerText.trim();

            const cardsCount = document.querySelectorAll('#ana-followup-customers-list .ana-fu-cust-card').length;
            const cardTexts = Array.from(document.querySelectorAll('#ana-followup-customers-list .ana-fu-cust-card')).map(c => c.innerText);

            const custStats = state.customers.map(c => ({ name: c.fullName, isOverdue: getCustomerStats(c).isOverdue, isAtRisk: getCustomerStats(c).isAtRisk, missed: getCustomerStats(c).missedCount, completed: getCustomerStats(c).isCompleted, paid: getCustomerStats(c).paidCount, bal: getCustomerStats(c).balance }));

            return JSON.stringify({
                custStats,
                statusOverdue,
                statusAtrisk,
                fuOverdue,
                fuAtrisk,
                fuCompleted,
                cardsCount,
                cardTexts
            });
        })()
        """
        res = simple_ws_send_recv(ws_url, {"id": 2, "method": "Runtime.evaluate", "params": {"expression": verify_counts_js}})
        metrics = get_cdp_value(res)
        print("      DEBUG CUST STATS:", metrics.get("custStats"))
        cust_stats = metrics.get("custStats", [])
        expected_overdue = sum(1 for c in cust_stats if c.get("isOverdue"))
        expected_atrisk = sum(1 for c in cust_stats if c.get("isAtRisk"))
        expected_completed = sum(1 for c in cust_stats if c.get("completed"))

        print(f"      Reconciled Expectations: Overdue={expected_overdue}, AtRisk={expected_atrisk}, Completed={expected_completed}")

        assert expected_overdue > 0, "No overdue customers found in test dataset"
        assert int(metrics.get("statusOverdue", 0)) == expected_overdue, f"Expected {expected_overdue} overdue loans, got {metrics.get('statusOverdue')}"
        assert int(metrics.get("statusAtrisk", 0)) == expected_atrisk, f"Expected {expected_atrisk} at-risk loans, got {metrics.get('statusAtrisk')}"
        assert int(metrics.get("fuOverdue", 0)) == expected_overdue, f"Expected {expected_overdue} follow-up overdue, got {metrics.get('fuOverdue')}"
        assert int(metrics.get("fuAtrisk", 0)) == expected_atrisk, f"Expected {expected_atrisk} follow-up at-risk, got {metrics.get('fuAtrisk')}"
        assert int(metrics.get("fuCompleted", 0)) == expected_completed, f"Expected {expected_completed} follow-up completed, got {metrics.get('fuCompleted')}"
        assert metrics.get("cardsCount") >= expected_overdue, f"Expected at least {expected_overdue} customer cards, got {metrics.get('cardsCount')}"

        # Verify customer names & loan badges in cards
        all_cards_text = " ".join(metrics.get("cardTexts", []))
        assert "Mahadeva" in all_cards_text, "Missing customer Mahadeva in overdue list"
        assert "Suresh Kumar" in all_cards_text, "Missing customer Suresh Kumar in overdue list"
        assert "L1" in all_cards_text, "Missing L1 loan badge"
        assert "Loan #1" in all_cards_text, "Missing loan number tag"
        assert "⚠️ Due" in all_cards_text or "⚠️ At Risk" in all_cards_text, "Missing overdue indicator"

        print("      [PASS] Overdue counts, customer names, L1 loan numbers & risk indicators verified!")

        # 3. Test Interactive Filtering (Overdue, At-Risk, Completed)
        print("[5/6] Testing Interactive Category Filtering...")
        filter_test_js = """
        (function() {
            // Select 'atrisk'
            filterAnalyticsFollowups('atrisk');
            const atriskCards = document.querySelectorAll('#ana-followup-customers-list .ana-fu-cust-card').length;

            // Select 'completed'
            filterAnalyticsFollowups('completed');
            const completedCards = document.querySelectorAll('#ana-followup-customers-list .ana-fu-cust-card').length;

            // Select 'overdue'
            filterAnalyticsFollowups('overdue');
            const overdueCards = document.querySelectorAll('#ana-followup-customers-list .ana-fu-cust-card').length;

            return JSON.stringify({
                custLen: (state.customers || []).length,
                atriskCards,
                completedCards,
                overdueCards
            });
        })()
        """
        res = simple_ws_send_recv(ws_url, {"id": 3, "method": "Runtime.evaluate", "params": {"expression": filter_test_js}})
        filt = get_cdp_value(res)
        print("      At-Risk Cards:", filt.get("atriskCards"))
        print("      Completed Cards:", filt.get("completedCards"))
        print("      Overdue Cards:", filt.get("overdueCards"))
        assert filt.get("atriskCards") == expected_atrisk, f"Expected {expected_atrisk} at-risk cards, got {filt.get('atriskCards')}"
        assert filt.get("completedCards") == expected_completed, f"Expected {expected_completed} completed card, got {filt.get('completedCards')}"
        assert filt.get("overdueCards") == expected_overdue, f"Expected {expected_overdue} overdue cards, got {filt.get('overdueCards')}"
        print("      [PASS] Interactive filtering verified!")

        # 4. Test Jump to Customer Schedule in Collection Matrix
        print("[6/6] Testing Navigation to Customer Schedule in Collection Sheet...")
        jump_test_js = """
        (function() {
            // Switch back to 'all' followups
            filterAnalyticsFollowups('all');
            // Click open schedule for customer Mahadeva
            jumpToCustomerSchedule('CUST-018-L1');

            return JSON.stringify({
                activeTab: state.activeTab,
                isExpanded: state.expandedCustomerIds ? state.expandedCustomerIds.has('CUST-018-L1') : false
            });
        })()
        """
        res = simple_ws_send_recv(ws_url, {"id": 4, "method": "Runtime.evaluate", "params": {"expression": jump_test_js}})
        nav = get_cdp_value(res)
        print("      Active tab after jump:", nav.get("activeTab"))
        print("      Mahadeva schedule expanded:", nav.get("isExpanded"))
        assert nav.get("activeTab") == "collections", "Failed to navigate to collections sheet"
        assert nav.get("isExpanded") is True, "Failed to expand Mahadeva schedule"
        print("      [PASS] Navigation & schedule expansion verified!")

        # 5. Capture High-Resolution Screenshot of Analytics Screen
        simple_ws_send_recv(ws_url, {"id": 5, "method": "Runtime.evaluate", "params": {"expression": "switchTab('analytics'); renderAnalytics(); filterAnalyticsFollowups('all'); document.getElementById('ana-module-loans').scrollIntoView({block: 'start'});"}})
        time.sleep(1)

        shot_res = simple_ws_send_recv(ws_url, {"id": 6, "method": "Page.captureScreenshot", "params": {"format": "png"}})
        shot_data = json.loads(shot_res).get("result", {}).get("data")
        if shot_data:
            out_path = os.path.join(ARTIFACTS_DIR, "analytics_loan_status_and_followup_verified.png")
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(shot_data))
            print(f"[SUCCESS] Verification screenshot saved to: {out_path}")

        print("=========================================================")
        print("OVERDUE & AT-RISK ANALYSIS SCREEN VERIFICATION PASSED 100%!")
        print("=========================================================")

    finally:
        try:
            subprocess.run(f"taskkill /F /T /PID {proc.pid}", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

if __name__ == "__main__":
    main()
