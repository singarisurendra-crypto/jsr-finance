import os
import sys
import time
import json
import base64
import socket
import subprocess
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

PORT_HTTP = 8996
PORT_CDP = 9270
ARTIFACT_DIR = r"C:\Users\surendra.s\.gemini\antigravity\brain\9a0c6fee-fcaa-42a0-ade3-57b237e6eb62"

class WebSocketClient:
    def __init__(self, url):
        self.url = url
        self.req_id = 1
        self.buf = bytearray()
        parts = url.replace("ws://", "").split("/")
        host_port = parts[0].split(":")
        self.host = host_port[0]
        self.port = int(host_port[1])
        self.path = "/" + "/".join(parts[1:])
        self.s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.s.connect((self.host, self.port))
        self.s.settimeout(12.0)
        self._handshake()

    def _handshake(self):
        sec_key = base64.b64encode(os.urandom(16)).decode("utf-8")
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {sec_key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.s.sendall(req.encode("utf-8"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.s.recv(1024)

    def send(self, method, params=None):
        mid = self.req_id
        self.req_id += 1
        msg = {"id": mid, "method": method, "params": params or {}}
        raw = json.dumps(msg).encode("utf-8")
        frame = bytearray([0x81])
        length = len(raw)
        if length < 126:
            frame.append(0x80 | length)
        else:
            frame.append(0x80 | 126)
            frame.extend(length.to_bytes(2, "big"))
        mask = os.urandom(4)
        frame.extend(mask)
        for i in range(length):
            frame.append(raw[i] ^ mask[i % 4])
        self.s.sendall(frame)
        return mid

    def recv_msg(self, target_id=None, timeout=12.0):
        start = time.time()
        while time.time() - start < timeout:
            # First check if a frame is already in self.buf
            while len(self.buf) >= 2:
                plen = self.buf[1] & 0x7F
                offset = 2
                if plen == 126:
                    if len(self.buf) < 4:
                        break
                    plen = int.from_bytes(self.buf[2:4], "big")
                    offset = 4
                elif plen == 127:
                    if len(self.buf) < 10:
                        break
                    plen = int.from_bytes(self.buf[2:10], "big")
                    offset = 10
                if len(self.buf) < offset + plen:
                    break
                frame_data = self.buf[offset:offset+plen].decode("utf-8", errors="ignore")
                del self.buf[:offset+plen]
                try:
                    msg = json.loads(frame_data)
                    if target_id is None or msg.get("id") == target_id:
                        return msg
                except Exception:
                    pass

            try:
                chunk = self.s.recv(4096)
                if chunk:
                    self.buf.extend(chunk)
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
            raw = base64.b64decode(res["result"]["data"])
            filepath = os.path.join(ARTIFACT_DIR, filename)
            with open(filepath, "wb") as f:
                f.write(raw)
            print(f"[SCREENSHOT SAVED]: {filename} ({len(raw)} bytes)")
            return True
        print(f"[FAIL] Could not capture screenshot: {filename}")
        return False

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass

def main():
    print("=== STARTING MODAL FIXES VISUAL & FUNCTIONAL VERIFICATION ===")
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT_HTTP), SimpleHTTPRequestHandler)
    import threading
    t = threading.Thread(target=httpd.serve_forever)
    t.daemon = True
    t.start()
    print(f"HTTP Server listening on http://127.0.0.1:{PORT_HTTP}")

    edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    ]
    edge_bin = next((p for p in edge_paths if os.path.exists(p)), "msedge.exe")

    user_data = os.path.join(ARTIFACT_DIR, "edge_verify_modal_fixes")
    cmd = [
        edge_bin,
        "--headless=new",
        f"--remote-debugging-port={PORT_CDP}",
        f"--user-data-dir={user_data}",
        "--no-first-run",
        "--no-default-browser-check",
        f"http://127.0.0.1:{PORT_HTTP}/index.html"
    ]
    proc = subprocess.Popen(cmd)
    print(f"Edge started (PID: {proc.pid}) on CDP port {PORT_CDP}")

    ws = None
    try:
        ws_url = None
        for _ in range(25):
            time.sleep(0.5)
            try:
                resp = urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json", timeout=2)
                tabs = json.loads(resp.read().decode("utf-8"))
                for tb in tabs:
                    if tb.get("type") == "page" and str(PORT_HTTP) in tb.get("url", ""):
                        ws_url = tb.get("webSocketDebuggerUrl")
                        break
                if ws_url:
                    break
            except Exception:
                pass

        if not ws_url:
            print("[FAIL] Could not connect to Edge DevTools")
            return

        print(f"Connected to CDP page target: {ws_url}")
        ws = WebSocketClient(ws_url)
        ws.send("Page.enable")
        ws.send("DOM.enable")

        # Desktop Viewport: 1280 x 800 (as seen in user screenshot)
        ws.send("Emulation.setDeviceMetricsOverride", {
            "width": 1280,
            "height": 800,
            "deviceScaleFactor": 1,
            "mobile": False
        })
        time.sleep(1.0)

        # Wait for app.js to initialize
        ready = False
        for i in range(15):
            res = ws.eval_js("typeof quickLoginOwner === 'function' && typeof renderCollectionMatrix === 'function'")
            print(f"Poll attempt {i+1}: eval returned {res}")
            if res:
                ready = True
                break
            # check document title / readyState
            state_js = ws.eval_js("document.readyState")
            print(f"  document.readyState: {state_js}")
            time.sleep(1.0)
        print(f"app.js initialized: {ready}")
        assert ready, "app.js failed to initialize"

        ws.eval_js("quickLoginOwner();")
        time.sleep(1.5)

        # 1. VERIFY BALANCE PAYABLE ON INSTALMENT SCREEN
        bal_text = ws.eval_js("(() => { const el = document.querySelector('.cust-financial-terms .cust-bal-payable'); return el ? el.innerText : null; })()")
        print(f"Instalment screen Bal Payable pill: {bal_text}")
        assert bal_text and "Bal:" in bal_text, f"Balance payable pill missing or invalid: {bal_text}"
        ws.screenshot("instalment_screen_balance_verified.png")

        # 2. OPEN CUSTOMER DETAIL MODAL FOR SRI RAM LOAN 2 (CUSTOMER WITH PAID & PARTIAL INSTALMENTS)
        ws.eval_js("(() => { const c = state.customers.find(x => x.customerNumber == 1 && (x.loanNumber == 2 || x.loanNumber === '2')) || state.customers[0]; openCustomerDetailModal(c.id); })()")
        time.sleep(0.8)

        # 3. VERIFY GREEN CHECKBOXES & PARTIAL BOXES IN MODAL GRID
        paid_boxes_count = ws.eval_js("document.querySelectorAll('#cust-detail-loan-content .sched-box-btn.is-paid').length")
        partial_boxes_count = ws.eval_js("document.querySelectorAll('#cust-detail-loan-content .sched-box-btn.is-partial').length")
        check_symbols_count = ws.eval_js("(() => { let cnt = 0; document.querySelectorAll('#cust-detail-loan-content .sched-box-btn.is-paid').forEach(b => { if (b.innerText.trim() === '✓') cnt++; }); return cnt; })()")
        print(f"Modal Paid boxes count: {paid_boxes_count}, Partial boxes count: {partial_boxes_count}, Checkmarks rendered: {check_symbols_count}")
        assert paid_boxes_count > 0, "No green checkmark boxes rendered in customer detail modal!"
        assert check_symbols_count == paid_boxes_count, "Checkmark symbol missing inside is-paid button"

        # Check background color of paid box (should be green #16a34a rgb(22, 163, 74))
        paid_box_bg = ws.eval_js("(() => { const el = document.querySelector('#cust-detail-loan-content .sched-box-btn.is-paid'); return el ? window.getComputedStyle(el).backgroundColor : null; })()")
        print(f"Computed background of paid box in modal: {paid_box_bg}")
        assert "22, 163, 74" in (paid_box_bg or ""), f"Paid box does not have green background: {paid_box_bg}"

        # Check Balance Payable in modal banner and toolbar
        modal_text = ws.eval_js("document.getElementById('cust-detail-loan-content').innerText")
        has_banner = "balance payable" in modal_text.lower()
        has_toolbar = "bal payable:" in modal_text.lower()
        print(f"Modal has Balance Payable banner: {has_banner}, toolbar: {has_toolbar}")
        assert has_banner and has_toolbar, f"Balance Payable missing from modal content: {modal_text[:300]}"
        ws.screenshot("customer_detail_modal_green_checks_verified.png")

        # 4. CLICK OUT-OF-SEQUENCE CELL IN MODAL (e.g. CELL 1 WHEN LAST PAID IS CELL 32)
        ws.eval_js("(() => { const c = state.customers.find(x => x.customerNumber == 1 && (x.loanNumber == 2 || x.loanNumber === '2')) || state.customers[0]; handleDetailInstalmentClick(c.id, 1); })()")
        time.sleep(0.5)

        # 5. VERIFY WARNING ALERT APPEARS PROMINENTLY IN MODAL & TOAST (NOT HIDDEN)
        in_modal_alert = ws.eval_js("document.getElementById('cust-detail-alert-box').style.display !== 'none'")
        in_modal_text = ws.eval_js("document.getElementById('cust-detail-alert-box').innerText")
        toast_disp = ws.eval_js("document.getElementById('app-toast').style.display !== 'none'")
        toast_zindex = ws.eval_js("window.getComputedStyle(document.getElementById('app-toast')).zIndex")
        print(f"In-modal alert displayed: {in_modal_alert}, text: {in_modal_text}")
        print(f"Toast displayed: {toast_disp}, z-index: {toast_zindex}")
        assert in_modal_alert and "Out of sequence" in in_modal_text, f"In-modal alert did not show: {in_modal_text}"
        assert toast_disp and int(toast_zindex) >= 100000, f"Floating toast not on top: zIndex={toast_zindex}"
        ws.screenshot("customer_detail_modal_alert_visible_verified.png")

        print("\n=======================================================")
        print("ALL MODAL & BALANCE PAYABLE FIXES VERIFIED SUCCESSFULLY!")
        print("=======================================================")

    finally:
        if ws:
            ws.close()
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        httpd.shutdown()

if __name__ == '__main__':
    main()
