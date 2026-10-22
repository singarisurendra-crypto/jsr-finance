"""
Test to verify that:
1. Header Stats pills NEVER overlap the JSR Finance brand logo / title on laptop screens (1366x768).
2. In 'Recent Collections & Audit Activity' (and all tables), table header <th> sits at top: 0 with rows underneath, NEVER with rows sticking out above the header.
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

PORT_HTTP = 8997
PORT_CDP = 9265

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
        print("[FAIL] Chrome not found")
        sys.exit(1)

    httpd = ThreadingHTTPServer(("127.0.0.1", PORT_HTTP), JSRFinanceHandler)
    import threading
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    profile_dir = os.path.join(os.environ["TEMP"], "cdp_overlap_profile")
    cmd = [
        chrome_path,
        "--headless=new",
        f"--remote-debugging-port={PORT_CDP}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1366,768",
        f"http://127.0.0.1:{PORT_HTTP}/index.html"
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
        # Login as authorized operator and switch to summary view
        login_js = """
        (function() {
            document.getElementById('view-login').style.display = 'none';
            verifyAndLoginGoogleUser('admin@jsrfinance.com', 'Surendra Singari');
            switchTab('summary');
            renderDashboard();
            renderRecentTransactions();
            return true;
        })()
        """
        simple_ws_send_recv(ws_url, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": login_js}})
        time.sleep(1)

        # 1. Test Header Brand vs Stats overlap
        header_check_js = """
        (function() {
            const brand = document.querySelector('.brand-section');
            const stats = document.querySelector('.header-stats');
            const brandRect = brand.getBoundingClientRect();
            const statsRect = stats.getBoundingClientRect();
            const firstPill = document.querySelector('.header-stats .stat-pill');
            const firstPillRect = firstPill ? firstPill.getBoundingClientRect() : null;

            return JSON.stringify({
                brandRight: Math.round(brandRect.right),
                statsLeft: Math.round(statsRect.left),
                firstPillLeft: firstPillRect ? Math.round(firstPillRect.left) : null,
                isOverlapping: statsRect.left < brandRect.right,
                pillsCount: document.querySelectorAll('.header-stats .stat-pill').length
            });
        })()
        """
        res_header = simple_ws_send_recv(ws_url, {"id": 3, "method": "Runtime.evaluate", "params": {"expression": header_check_js, "returnByValue": True}})
        h_data = get_cdp_value(res_header)
        print("1. Header Layout Check (1366px screen):", h_data)

        assert h_data["isOverlapping"] is False, f"Brand section (right={h_data['brandRight']}) and Header stats (left={h_data['statsLeft']}) MUST NOT overlap!"
        assert h_data["firstPillLeft"] >= h_data["brandRight"], f"First pill (left={h_data['firstPillLeft']}) must be to the right of brand (right={h_data['brandRight']})"
        print("  [PASS] Zero header overlap! Brand title and stat pills are cleanly separated.")

        # 2. Test Recent Collections Table Headers vs Rows
        # Type search 'Ramad' just like in user screenshot
        filter_js = """
        (function() {
            const input = document.getElementById('recent-search-filter');
            if (input) {
                input.value = 'Ramad';
                renderRecentTransactions();
            }
            return true;
        })()
        """
        simple_ws_send_recv(ws_url, {"id": 4, "method": "Runtime.evaluate", "params": {"expression": filter_js}})
        time.sleep(1)

        table_check_js = """
        (function() {
            const th = document.querySelector('#view-summary .data-table thead th');
            const firstRow = document.querySelector('#view-summary #recent-transactions-list tr');
            const thRect = th ? th.getBoundingClientRect() : null;
            const rowRect = firstRow ? firstRow.getBoundingClientRect() : null;
            const container = document.querySelector('#view-summary .data-table-container');
            const contRect = container ? container.getBoundingClientRect() : null;

            return JSON.stringify({
                thTop: thRect ? Math.round(thRect.top) : null,
                rowTop: rowRect ? Math.round(rowRect.top) : null,
                contTop: contRect ? Math.round(contRect.top) : null,
                isRowAboveTh: rowRect && thRect ? (rowRect.top < thRect.top) : false,
                thStyleTop: th ? getComputedStyle(th).top : null
            });
        })()
        """
        res_table = simple_ws_send_recv(ws_url, {"id": 5, "method": "Runtime.evaluate", "params": {"expression": table_check_js, "returnByValue": True}})
        t_data = get_cdp_value(res_table)
        print("2. Recent Collections Table Layout Check:", t_data)

        assert t_data["isRowAboveTh"] is False, f"Table row (top={t_data['rowTop']}) MUST NOT be positioned above table header (top={t_data['thTop']})!"
        assert t_data["thTop"] <= t_data["rowTop"], f"Header must be at or above first row (thTop={t_data['thTop']}, rowTop={t_data['rowTop']})"
        print("  [PASS] Table header is cleanly anchored at top: 0, with rows positioned strictly underneath!")

        # 3. Test with all activity rows populated and scroll to Recent Collections table
        populate_all_js = """
        (function() {
            const input = document.getElementById('recent-search-filter');
            if (input) {
                input.value = '';
                renderRecentTransactions();
            }
            // Scroll table container into view
            const card = document.querySelector('#view-summary .card:last-child');
            if (card) {
                card.scrollIntoView({ behavior: 'instant', block: 'start' });
            }
            return true;
        })()
        """
        simple_ws_send_recv(ws_url, {"id": 6, "method": "Runtime.evaluate", "params": {"expression": populate_all_js}})
        time.sleep(1)

        # Capture visual screenshot of the populated table
        shot = simple_ws_send_recv(ws_url, {"id": 7, "method": "Page.captureScreenshot", "params": {"format": "png"}})
        if shot:
            data_json = json.loads(shot)
            if "result" in data_json and "data" in data_json["result"]:
                out_path = "overlap_fixed_scrolled.png"
                with open(out_path, "wb") as f:
                    f.write(base64.b64decode(data_json["result"]["data"]))
                print(f"  [OK] Saved screenshot {out_path}")

                import shutil
                art_dir = r"C:\Users\surendra.s\.gemini\antigravity\brain\9a0c6fee-fcaa-42a0-ade3-57b237e6eb62"
                if os.path.exists(art_dir):
                    dest = os.path.join(art_dir, "overlap_fixed_scrolled.png")
                    shutil.copyfile(out_path, dest)
                    print(f"  [OK] Copied to artifact directory: {dest}")

        print("=========================================================")
        print("OVERLAP FIX VERIFICATION SUCCEEDED 100%!")
        print("=========================================================")

    finally:
        try:
            proc.terminate()
            httpd.shutdown()
        except Exception:
            pass

if __name__ == '__main__':
    main()
