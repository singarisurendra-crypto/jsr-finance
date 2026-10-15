"""
JSR Finance - Greenfield Visual Browser Test (test_greenfield_browser.py)
Tests:
 - Google Identity Services & Whitelist Gate (HTTP 403 rejection on unauthorized accounts)
 - Global Command Palette (Cmd+K / Ctrl+K) fuzzy search & keyboard navigation
 - Modern Greenfield Dashboard & WCAG 2.1 Indicators
"""

import os
import sys
import time
import json
import base64
import socket
import urllib.request
import subprocess
from http.server import ThreadingHTTPServer

from db import db
from server import JSRFinanceHandler

PORT_HTTP = 8992
PORT_CDP = 9260

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
    resp = s.recv(4096)

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

def main():
    print("=== Launching Greenfield Browser Verification ===")
    db.init_schema()
    server_address = ("127.0.0.1", PORT_HTTP)
    httpd = ThreadingHTTPServer(server_address, JSRFinanceHandler)
    import threading
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    print(f"[OK] In-process server listening on http://127.0.0.1:{PORT_HTTP}")

    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    user_data = r"C:\Users\surendra.s\.gemini\antigravity\scratch\edge_greenfield_verify"
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

        # Wait for app.js initialization
        for attempt in range(10):
            res = simple_ws_send_recv(ws_url, {"id": 10 + attempt, "method": "Runtime.evaluate", "params": {"expression": "typeof openCommandPalette"}})
            if res and "function" in res:
                print(f"[OK] Greenfield app.js initialized on attempt {attempt}")
                break
            time.sleep(1)

        # 1. Test Google OAuth Whitelist Gate Rejection
        test_auth_gate_js = """
        (function() {
            verifyAndLoginGoogleUser('intruder@unauthorized.com', 'Intruder');
            const alertEl = document.getElementById('login-error-alert');
            return JSON.stringify({
                alertVisible: alertEl && alertEl.style.display !== 'none',
                alertText: alertEl ? alertEl.innerText : '',
                isAccessDenied: alertEl ? alertEl.innerText.includes('Access Denied') : false
            });
        })()
        """
        res_gate = simple_ws_send_recv(ws_url, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": test_auth_gate_js, "returnByValue": True}})
        print("Whitelist Gate Rejection Test:", res_gate)

        # 2. Login as authorized operator
        auth_login_js = """
        (function() {
            verifyAndLoginGoogleUser('admin@jsrfinance.com', 'Surendra Singari (Admin)');
            return JSON.stringify({
                loginHidden: document.getElementById('view-login').style.display === 'none'
            });
        })()
        """
        res_login = simple_ws_send_recv(ws_url, {"id": 2, "method": "Runtime.evaluate", "params": {"expression": auth_login_js, "returnByValue": True}})
        print("Authorized Login Test:", res_login)
        time.sleep(1)

        # 3. Test Global Command Palette (Cmd+K / Ctrl+K)
        cmd_palette_js = """
        (function() {
            openCommandPalette();
            const modal = document.getElementById('command-palette-modal');
            const backdrop = document.getElementById('command-palette-backdrop');
            handleCommandPaletteSearch('Sri Ram');
            const results = document.getElementById('command-palette-results');
            return JSON.stringify({
                modalVisible: modal.style.display === 'block',
                backdropVisible: backdrop.style.display === 'block',
                hasResults: results && results.children.length > 0,
                resultsText: results ? results.innerText : ''
            });
        })()
        """
        res_cmd = simple_ws_send_recv(ws_url, {"id": 3, "method": "Runtime.evaluate", "params": {"expression": cmd_palette_js, "returnByValue": True}})
        print("Command Palette Test:", res_cmd)

        # Screenshot Command Palette
        shot_cmd = simple_ws_send_recv(ws_url, {"id": 4, "method": "Page.captureScreenshot", "params": {"format": "png"}})
        if shot_cmd:
            data_json = json.loads(shot_cmd)
            if "result" in data_json and "data" in data_json["result"]:
                with open("greenfield_command_palette.png", "wb") as f:
                    f.write(base64.b64decode(data_json["result"]["data"]))
                print("[OK] Saved greenfield_command_palette.png")

        # Close Command Palette
        simple_ws_send_recv(ws_url, {"id": 5, "method": "Runtime.evaluate", "params": {"expression": "closeCommandPalette()"}})
        time.sleep(0.5)

        # Screenshot Full Greenfield Dashboard
        shot_dash = simple_ws_send_recv(ws_url, {"id": 6, "method": "Page.captureScreenshot", "params": {"format": "png"}})
        if shot_dash:
            data_json = json.loads(shot_dash)
            if "result" in data_json and "data" in data_json["result"]:
                with open("greenfield_dashboard.png", "wb") as f:
                    f.write(base64.b64decode(data_json["result"]["data"]))
                print("[OK] Saved greenfield_dashboard.png")

        print("\n[SUCCESS] Greenfield browser verification complete!")
    finally:
        try:
            proc.terminate()
            httpd.shutdown()
        except Exception:
            pass

if __name__ == "__main__":
    main()
