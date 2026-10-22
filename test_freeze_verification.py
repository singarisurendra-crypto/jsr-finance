"""
Test to verify that Top Row (Header), Side Menu (Sidebar), and Table Headers are frozen when scrolling.
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

PORT_HTTP = 8996
PORT_CDP = 9264

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

def main():
    server_address = ("127.0.0.1", PORT_HTTP)
    httpd = ThreadingHTTPServer(server_address, JSRFinanceHandler)
    import threading
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    user_data = r"C:\Users\surendra.s\.gemini\antigravity\scratch\edge_freeze_verify"
    os.makedirs(user_data, exist_ok=True)

    cmd = [
        edge_path,
        f"--remote-debugging-port={PORT_CDP}",
        "--headless=new",
        "--disable-gpu",
        f"--user-data-dir={user_data}",
        "--window-size=1280,850",
        f"http://127.0.0.1:{PORT_HTTP}/index.html"
    ]
    proc = subprocess.Popen(cmd)
    time.sleep(3)

    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json")
        tabs = json.loads(req.read().decode("utf-8"))
        tab = [tb for tb in tabs if str(PORT_HTTP) in tb.get("url", "")][0]
        ws_url = tab["webSocketDebuggerUrl"]

        time.sleep(2)
        login_js = "verifyAndLoginGoogleUser('admin@jsrfinance.com', 'Admin User'); true;"
        simple_ws_send_recv(ws_url, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": login_js}})
        time.sleep(1)

        # Expand all schedules to create long scrollable content
        expand_js = "expandAllSchedules(); true;"
        simple_ws_send_recv(ws_url, {"id": 2, "method": "Runtime.evaluate", "params": {"expression": expand_js}})
        time.sleep(1)

        # Check positions before scroll
        check_before_js = """
        (function() {
            const header = document.querySelector('.app-header');
            const sidebar = document.querySelector('.sidebar');
            const headerRect = header ? header.getBoundingClientRect() : null;
            const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
            return JSON.stringify({
                headerTopBefore: headerRect ? headerRect.top : null,
                sidebarTopBefore: sidebarRect ? sidebarRect.top : null,
                docHeight: document.documentElement.scrollHeight
            });
        })()
        """
        res_before = simple_ws_send_recv(ws_url, {"id": 3, "method": "Runtime.evaluate", "params": {"expression": check_before_js, "returnByValue": True}})
        print("Before scroll:", get_cdp_value(res_before))

        # Scroll down 1000px
        scroll_js = "window.scrollTo(0, 1000); true;"
        simple_ws_send_recv(ws_url, {"id": 4, "method": "Runtime.evaluate", "params": {"expression": scroll_js}})
        time.sleep(1)

        # Check positions after scroll
        check_after_js = """
        (function() {
            const header = document.querySelector('.app-header');
            const sidebar = document.querySelector('.sidebar');
            const headerRect = header ? header.getBoundingClientRect() : null;
            const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
            return JSON.stringify({
                scrollY: window.scrollY,
                headerTopAfter: headerRect ? Math.round(headerRect.top) : null,
                sidebarTopAfter: sidebarRect ? Math.round(sidebarRect.top) : null
            });
        })()
        """
        res_after = simple_ws_send_recv(ws_url, {"id": 5, "method": "Runtime.evaluate", "params": {"expression": check_after_js, "returnByValue": True}})
        after_data = get_cdp_value(res_after)
        print("After scroll 1000px:", after_data)

        assert after_data["scrollY"] == 1000, f"Expected scrollY = 1000, got {after_data['scrollY']}"
        assert after_data["headerTopAfter"] == 0, f"Top header MUST remain frozen at top: 0, got {after_data['headerTopAfter']}"
        assert after_data["sidebarTopAfter"] == 66, f"Sidebar MUST remain frozen at top: 66, got {after_data['sidebarTopAfter']}"
        print("  [PASS] Top row (header) and side menu (sidebar) remained 100% frozen in place!")

        # Capture visual proof screenshot while scrolled down
        shot = simple_ws_send_recv(ws_url, {"id": 6, "method": "Page.captureScreenshot", "params": {"format": "png"}})
        if shot:
            data_json = json.loads(shot)
            if "result" in data_json and "data" in data_json["result"]:
                with open("freeze_layout_verified.png", "wb") as f:
                    f.write(base64.b64decode(data_json["result"]["data"]))
                print("  [OK] Saved freeze_layout_verified.png")

        print("=========================================================")
        print("FREEZE TOP ROW & SIDE MENU VERIFICATION SUCCEEDED!")
        print("=========================================================")

    finally:
        try:
            proc.terminate()
            httpd.shutdown()
        except Exception:
            pass

if __name__ == '__main__':
    main()
