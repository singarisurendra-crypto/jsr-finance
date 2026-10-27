import os
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import time
import json
import base64
import socket
import urllib.request
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT_HTTP = 8995
PORT_CDP = 9269
ARTIFACT_DIR = r"C:\Users\surendra.s\.gemini\antigravity\brain\9a0c6fee-fcaa-42a0-ade3-57b237e6eb62"

class WebSocketClient:
    def __init__(self, ws_url):
        from urllib.parse import urlparse
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

    def recv_msg(self, target_id=None, timeout=8):
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
                val = res["result"]["result"].get("value")
                return val
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
    print("=== STARTING FULL END-TO-END VISUAL VERIFICATION ===")
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

    user_data = os.path.join(ARTIFACT_DIR, "edge_verify_new_suite")
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
        # Wait for CDP
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

        # Emulate Mobile Viewport: 375 x 812 (iPhone X/12)
        ws.send("Emulation.setDeviceMetricsOverride", {
            "width": 375,
            "height": 812,
            "deviceScaleFactor": 2,
            "mobile": True
        })
        time.sleep(1.0)

        # Poll until app.js finishes loading
        ready = False
        for _ in range(15):
            res = ws.eval_js("typeof quickLoginOwner === 'function' && typeof renderCollectionMatrix === 'function'")
            if res:
                ready = True
                break
            time.sleep(1.0)
        print(f"app.js initialized and quickLoginOwner present: {ready}")
        assert ready, "app.js failed to initialize in time"
        ws.eval_js("quickLoginOwner();")
        time.sleep(1.5)

        # 2. Check Top Header Offline Sync Badge
        sync_badge_text = ws.eval_js("document.getElementById('offline-sync-badge') ? document.getElementById('offline-sync-badge').innerText : null")
        print(f"Header Offline Sync Badge Text: {sync_badge_text}")
        assert sync_badge_text and ("Synced" in sync_badge_text or "Online" in sync_badge_text), f"Bad sync badge: {sync_badge_text}"

        # 3. Test Customer Profile Photo Lightbox on Avatar Click
        avatar_exists = ws.eval_js("document.querySelector('.cust-avatar') !== null")
        print(f"Borrower avatar exists in collection matrix: {avatar_exists}")
        if avatar_exists:
            ws.eval_js("(() => { const c = state.customers[0]; openCustomerPhotoLightbox(c.id); })()")
            time.sleep(0.5)
            lightbox_open = ws.eval_js("document.getElementById('photo-lightbox-backdrop').style.display !== 'none'")
            print(f"Photo lightbox displayed: {lightbox_open}")
            assert lightbox_open, "Photo lightbox failed to open"
            ws.screenshot("photo_lightbox_verified.png")
            ws.eval_js("closeCustomerPhotoLightbox();")
            time.sleep(0.3)

        # 4. Test Customer Detail Pop-up / Near-Full-Screen Mobile Bottom Sheet
        ws.eval_js("(() => { const c = state.customers[0]; openCustomerDetailModal(c.id); })()")
        time.sleep(0.6)
        modal_open = ws.eval_js("document.getElementById('modal-customer-detail').style.display !== 'none'")
        print(f"Customer detail bottom sheet displayed: {modal_open}")
        assert modal_open, "Customer detail bottom sheet failed to open"

        # Check multi-loan tabs inside bottom sheet
        loan_tabs_count = ws.eval_js("document.querySelectorAll('#cust-detail-loan-tabs .cust-loan-tab-btn').length")
        print(f"Loan selector tabs inside bottom sheet: {loan_tabs_count}")
        assert loan_tabs_count > 0, "No loan tabs found inside customer detail modal"
        ws.screenshot("customer_detail_bottom_sheet_verified.png")

        # Test Close button
        ws.eval_js("requestCloseCustomerDetailModal();")
        time.sleep(0.3)
        modal_closed = ws.eval_js("document.getElementById('modal-customer-detail').style.display === 'none'")
        print(f"Customer detail bottom sheet closed: {modal_closed}")
        assert modal_closed, "Customer detail bottom sheet failed to close"

        # 5. Test Loan Date Lock on Customer Edit Screen
        # Pick customer with payments (or mark one payment to ensure hasAnyPayment)
        ws.eval_js("""(() => {
            const c = state.customers[0];
            if (!c.instalments || c.instalments.length === 0) {
                c.instalments = [{ number: 1, status: 'Received', paidAmount: c.instalmentAmount || 200 }];
            } else {
                c.instalments[0].status = 'Received';
                c.instalments[0].paidAmount = c.instalmentAmount || 200;
            }
            openEditCustomerModal(c.id);
        })()""")
        time.sleep(0.6)
        date_disabled = ws.eval_js("document.getElementById('cust-form-date').disabled")
        date_readonly = ws.eval_js("document.getElementById('cust-form-date').readOnly")
        lock_notice_disp = ws.eval_js("document.getElementById('cust-form-lock-notice').style.display !== 'none'")
        print(f"Date input locked: disabled={date_disabled}, readOnly={date_readonly}, notice={lock_notice_disp}")
        assert date_disabled and date_readonly and lock_notice_disp, "Loan date was not locked when payments exist"
        ws.screenshot("date_locked_edit_verified.png")
        ws.eval_js("closeModal('modal-customer');")
        time.sleep(0.3)

        # 6. Test Settings View: Admin Email & Field Collectors Roster
        ws.eval_js("switchTab('settings');")
        time.sleep(0.5)
        admin_email_val = ws.eval_js("document.getElementById('setting-admin-email').value")
        roster_rows = ws.eval_js("document.querySelectorAll('#collectors-roster-container tr').length")
        print(f"Settings Admin Email: {admin_email_val}, Collectors Roster rows: {roster_rows}")
        assert admin_email_val, "Admin email empty in settings"
        assert roster_rows > 0, "No rows in collectors roster table"
        ws.screenshot("collectors_roster_verified.png")

        # 7. Test Admin-Only Operator Breakdown on Summary Dashboard
        ws.eval_js("switchTab('summary');")
        time.sleep(0.6)
        breakdown_disp = ws.eval_js("document.getElementById('dashboard-collector-breakdown').style.display !== 'none'")
        breakdown_cards_count = ws.eval_js("document.querySelectorAll('#collector-breakdown-cards .collector-card').length")
        print(f"Admin Dashboard Operator Breakdown visible: {breakdown_disp}, Card count: {breakdown_cards_count}")
        assert breakdown_disp, "Dashboard collector breakdown not displayed for Admin"
        assert breakdown_cards_count >= 1, "No operator cards in breakdown"
        ws.screenshot("admin_collector_breakdown_verified.png")

        # 8. Test Handover Slip Modal
        ws.eval_js("openCollectorHandoverModal('Admin');")
        time.sleep(0.5)
        handover_open = ws.eval_js("document.getElementById('modal-collector-handover').classList.contains('active')")
        print(f"Collector Handover slip opened: {handover_open}")
        assert handover_open, "Handover slip modal failed to open"
        ws.screenshot("collector_handover_slip_verified.png")
        ws.eval_js("closeModal('modal-collector-handover');")
        time.sleep(0.3)

        print("\n=======================================================")
        print("ALL VISUAL AND FUNCTIONAL CDP TESTS PASSED PERFECTLY!")
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
