import os
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import time
import json
import base64
import socket
import urllib.request
from urllib.parse import urlparse
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT_HTTP = 8996
PORT_CDP = 9283
ARTIFACT_DIR = r"C:\Users\surendra.s\.gemini\antigravity\brain\9a0c6fee-fcaa-42a0-ade3-57b237e6eb62"

class WebSocketClient:
    def __init__(self, ws_url):
        u = urlparse(ws_url)
        self.s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.s.connect((u.hostname, u.port))
        key = base64.b64encode(b"1234567890123456").decode("utf-8")
        req = (
            f"GET {u.path} HTTP/1.1\r\n"
            f"Host: {u.hostname}:{u.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.s.sendall(req.encode("utf-8"))
        self.s.recv(4096)
        self.msg_id = 0

    def send(self, method, params=None):
        self.msg_id += 1
        payload = json.dumps({"id": self.msg_id, "method": method, "params": params or {}}).encode("utf-8")
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
        self.s.sendall(frame)
        return self.msg_id

    def recv_msg(self, target_id=None, timeout=10):
        start = time.time()
        self.s.settimeout(1.0)
        buf = bytearray()
        while time.time() - start < timeout:
            try:
                data = self.s.recv(65536)
                if not data:
                    break
                buf.extend(data)
                while len(buf) > 2:
                    plen = buf[1] & 0x7F
                    offset = 2
                    if plen == 126:
                        if len(buf) < 4:
                            break
                        plen = (buf[2] << 8) | buf[3]
                        offset = 4
                    elif plen == 127:
                        if len(buf) < 10:
                            break
                        plen = int.from_bytes(buf[2:10], 'big')
                        offset = 10
                    if len(buf) >= offset + plen:
                        frame_data = buf[offset:offset+plen].decode("utf-8", errors="ignore")
                        del buf[:offset+plen]
                        try:
                            msg = json.loads(frame_data)
                            if target_id is None or msg.get("id") == target_id:
                                return msg
                        except Exception:
                            pass
                    else:
                        break
            except socket.timeout:
                continue
            except Exception:
                break
        return None

    def eval_js(self, expr):
        mid = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        res = self.recv_msg(target_id=mid)
        if res and "result" in res:
            if "exceptionDetails" in res["result"]:
                print(f"[JS ERROR]: {res['result']['exceptionDetails']}")
            if "result" in res["result"]:
                return res["result"]["result"].get("value")
        return None

    def screenshot(self, filename):
        mid = self.send("Page.captureScreenshot", {"format": "png"})
        res = self.recv_msg(target_id=mid, timeout=12)
        if res and "result" in res and "data" in res["result"]:
            filepath = os.path.join(ARTIFACT_DIR, filename)
            with open(filepath, "wb") as f:
                f.write(base64.b64decode(res["result"]["data"]))
            print(f"[SCREENSHOT SAVED]: {filepath}")
            return filepath
        return None

def main():
    print("--- 1. Testing Code Integrity & Structure ---")
    with open("index.html", encoding="utf-8") as f:
        html = f.read()

    with open("app.js", encoding="utf-8") as f:
        js = f.read()

    with open("firebase-sync.js", encoding="utf-8") as f:
        sync_js = f.read()

    # 1. Check login screen changes
    assert "quickLoginOwner" not in html, "ERROR: quickLoginOwner found in index.html"
    assert "promptGoogleEmailFallback" not in html, "ERROR: promptGoogleEmailFallback found in index.html"
    assert "1-Click Fast Sign-In" not in html, "ERROR: 1-Click button found in index.html"
    assert "Sign in with another operator email" not in html, "ERROR: fallback link found in index.html"
    assert "btn-google-sso-main" in html, "ERROR: btn-google-sso-main missing in index.html"
    assert "Sign In with Google" in html, "ERROR: Sign In with Google text missing"
    print("[PASS] Login screen contains ONLY official Google Sign-In (no 1-click or email prompt)")

    # 2. Check top menu changes
    assert 'class="mobile-header-btn" data-tab="settings"' not in html, "ERROR: Settings button still in top menu mobile-header-actions"
    assert "handleSyncPillClick()" in html, "ERROR: handleSyncPillClick missing from index.html"
    assert "Live (Google Cloud Firebase)" in html, "ERROR: Live (Google Cloud Firebase) missing in index.html"
    print("[PASS] Top header menu clean: Settings removed from top header; Sync pill updated")

    # 3. Check Settings view card
    assert "card-cloud-firebase-sync" in html, "ERROR: card-cloud-firebase-sync missing in index.html"
    assert "jsr-finance-app-4a72e" in html, "ERROR: Project ID missing in Settings card"
    assert "handleSyncPillClick" in js, "ERROR: handleSyncPillClick missing from app.js"
    print("[PASS] Google Cloud Firebase sync card properly integrated into Settings & Configuration screen")

    # 4. Check app.js for absence of hardcoded bypasses
    assert "function quickLoginOwner" not in js, "ERROR: quickLoginOwner definition still in app.js"
    assert "function promptGoogleEmailFallback" not in js, "ERROR: promptGoogleEmailFallback still in app.js"
    print("[PASS] No hardcoded login bypass functions exist in app.js")

    print("\n--- 2. Automated Visual & Browser Verification via Edge CDP ---")
    server = ThreadingHTTPServer(("127.0.0.1", PORT_HTTP), SimpleHTTPRequestHandler)
    import threading
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    ]
    edge_exe = next((p for p in edge_paths if os.path.exists(p)), None)
    if not edge_exe:
        print("Edge binary not found.")
        return

    user_data = os.path.join(ARTIFACT_DIR, "edge_verify_login_and_sync")
    cmd = [
        edge_exe,
        f"--remote-debugging-port={PORT_CDP}",
        f"--user-data-dir={user_data}",
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--window-size=1280,820",
        f"http://127.0.0.1:{PORT_HTTP}/index.html"
    ]
    proc = subprocess.Popen(cmd)
    try:
        time.sleep(3)
        targets_url = f"http://127.0.0.1:{PORT_CDP}/json"
        req = urllib.request.urlopen(targets_url)
        targets = json.loads(req.read().decode("utf-8"))
        page_target = next(t for t in targets if t.get("type") == "page")
        ws_url = page_target["webSocketDebuggerUrl"]

        client = WebSocketClient(ws_url)
        client.send("Page.enable")
        client.send("DOM.enable")

        # 1. Verify Login Screen DOM
        login_state = client.eval_js("""
            (() => {
                const loginView = document.getElementById('view-login');
                const googleBtn = document.getElementById('btn-google-sso-main');
                const text = loginView ? loginView.innerText : '';
                return {
                    isLoginVisible: loginView && getComputedStyle(loginView).display !== 'none',
                    hasGoogleBtn: !!googleBtn,
                    has1Click: text.includes('1-Click') || text.includes('Surendra Singari'),
                    hasFallbackEmail: text.includes('Sign in with another')
                };
            })()
        """)
        print("Login Screen State:", json.dumps(login_state, indent=2))
        assert login_state["isLoginVisible"] is True, "Login screen should be visible"
        assert login_state["hasGoogleBtn"] is True, "Google Sign-In button must exist"
        assert login_state["has1Click"] is False, "1-Click button must NOT exist"
        assert login_state["hasFallbackEmail"] is False, "Fallback email link must NOT exist"

        client.screenshot("login_screen_strictly_google_verified.png")

        # 2. Authenticate session & verify Top Menu & Sync: Live (Google Cloud Firebase)
        client.eval_js("""
            (() => {
                localStorage.setItem('jsr_finance_operator_session', JSON.stringify({
                    user: 'Surendra Singari',
                    email: 'singarisurendra@gmail.com',
                    role: 'Admin',
                    provider: 'Google SSO'
                }));
                document.getElementById('view-login').style.display = 'none';
                loadData();
                updateHeaderStats();
                switchTab('collections');
            })()
        """)
        time.sleep(1)

        # 3. Check that Settings is NOT in the top menu
        top_menu_state = client.eval_js("""
            (() => {
                const topSettingsBtn = document.querySelector('.mobile-header-actions .mobile-header-btn[data-tab="settings"]');
                const syncPill = document.getElementById('cloud-status-pill');
                return {
                    topSettingsBtnExists: !!topSettingsBtn,
                    syncPillText: syncPill ? syncPill.innerText : ''
                };
            })()
        """)
        print("Top Menu State:", json.dumps(top_menu_state, indent=2))
        assert top_menu_state["topSettingsBtnExists"] is False, "Settings button must be removed from top menu"
        assert "Google Cloud Firebase" in top_menu_state["syncPillText"], "Sync pill must show Google Cloud Firebase"

        # 4. Click Sync Pill and verify transition to Settings & Config screen
        click_state = client.eval_js("""
            (() => {
                handleSyncPillClick();
                const settingsView = document.getElementById('view-settings');
                const syncCard = document.getElementById('card-cloud-firebase-sync');
                return {
                    isSettingsActive: settingsView && settingsView.classList.contains('active'),
                    syncCardExists: !!syncCard,
                    syncCardTitle: syncCard ? syncCard.querySelector('h3').innerText : ''
                };
            })()
        """)
        print("After Sync Pill Click State:", json.dumps(click_state, indent=2))
        assert click_state["isSettingsActive"] is True, "Clicking Sync pill must activate Settings & Config view"
        assert click_state["syncCardExists"] is True, "Google Cloud Firebase Sync card must exist in Settings"

        time.sleep(0.5)
        client.screenshot("settings_screen_cloud_firebase_sync_verified.png")

        print("\n[SUCCESS] ALL VERIFICATIONS PASSED (100%) - ZERO DEFECTS FOUND")
    finally:
        proc.terminate()
        server.shutdown()

if __name__ == "__main__":
    main()
