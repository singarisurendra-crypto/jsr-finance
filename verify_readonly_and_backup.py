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
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT_HTTP = 8993
PORT_CDP = 9247
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
                        plen = int.from_bytes(buf[2:10], byteorder="big")
                        offset = 10

                    if len(buf) < offset + plen:
                        break

                    msg_bytes = buf[offset:offset+plen]
                    buf = buf[offset+plen:]
                    msg = json.loads(msg_bytes.decode("utf-8", errors="ignore"))
                    if target_id is None or msg.get("id") == target_id:
                        return msg
            except socket.timeout:
                continue
            except Exception as e:
                break
        return None

def eval_js(ws, expr):
    msg_id = ws.send("Runtime.evaluate", {
        "expression": expr,
        "returnByValue": True,
        "awaitPromise": True
    })
    res = ws.recv_msg(target_id=msg_id)
    if res and "result" in res:
        if "exceptionDetails" in res["result"]:
            print("[JS EXCEPTION]", json.dumps(res["result"]["exceptionDetails"], indent=2))
        if "result" in res["result"]:
            return res["result"]["result"].get("value")
    return None

def main():
    print("=" * 70)
    print("  VERIFY READ-ONLY WHITELIST USERS & MIDNIGHT BACKUPS")
    print("=" * 70)

    # 1. Start HTTP Server
    os.chdir(r"c:\Work\Mini_Finance")
    server = ThreadingHTTPServer(("127.0.0.1", PORT_HTTP), SimpleHTTPRequestHandler)
    th = threading.Thread(target=server.serve_forever, daemon=True)
    th.start()
    print(f"[*] Local HTTP server listening at http://127.0.0.1:{PORT_HTTP}")

    # 2. Launch Headless Edge
    edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    ]
    edge_bin = next((p for p in edge_paths if os.path.exists(p)), None)
    if not edge_bin:
        print("[!] Microsoft Edge not found")
        sys.exit(1)

    user_data = os.path.join(os.getcwd(), "tmp_verify_readonly_profile")
    cmd = [
        edge_bin,
        "--headless=new",
        f"--remote-debugging-port={PORT_CDP}",
        f"--user-data-dir={user_data}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-http-cache",
        "--disk-cache-size=1",
        f"http://127.0.0.1:{PORT_HTTP}/index.html"
    ]
    proc = subprocess.Popen(cmd)
    print(f"[*] Launched headless Edge on CDP port {PORT_CDP}")
    time.sleep(2.5)

    ws = None
    try:
        # 3. Connect CDP to Page target
        req = urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json")
        tabs = json.loads(req.read().decode())
        page_target = next((t for t in tabs if t.get("type") == "page" and "index.html" in t.get("url", "")), None)
        if not page_target:
            page_target = next(t for t in tabs if t.get("type") == "page")
        ws_url = page_target["webSocketDebuggerUrl"]
        ws = WebSocketClient(ws_url)
        print(f"[*] Connected to Chrome DevTools Protocol WebSocket (Page: {page_target.get('title', 'index.html')})")

        # Wait for page load
        time.sleep(2.5)

        # 4. Set up mock environment with Whitelist and Field Collectors
        setup_script = """
        (function() {
            // Configure settings
            state.settings = state.settings || {};
            state.settings.adminEmail = 'singarisurendra@gmail.com';
            state.settings.adminName = 'Surendra Singari';
            state.settings.operatorWhitelist = 'auditor@jsrfinance.com, partner@jsrfinance.com';
            state.settings.collectors = [
                { id: 'COL-1', name: 'Singari Suri', email: 'singarisurendra24@gmail.com', phone: '9876543210', route: 'R-1', active: true },
                { id: 'COL-2', name: 'P D Sreekanth', email: 'casreekanthpd@gmail.com', phone: '9876543211', route: 'R-2', active: true }
            ];

            // Sample customer
            state.customers = [{
                id: 'CUST-1-L1-TEST',
                customerNumber: '1',
                loanNumber: 1,
                fullName: 'Test Borrower',
                givenAmount: 10000,
                totalInstalments: 52,
                instalmentAmount: 200,
                totalPayable: 10400,
                startDate: '2026-01-01',
                status: 'Active',
                frequency: 'Weekly',
                areaRoute: 'R-1',
                instalments: Array.from({length: 52}, (_, i) => ({
                    number: i + 1,
                    dueAmount: 200,
                    paidAmount: 0,
                    status: 'Pending'
                }))
            }];
            state.transactions = [];
            saveData();
            return true;
        })();
        """
        eval_js(ws, setup_script)
        print("[*] Test environment state initialized")

        # -------------------------------------------------------------
        # TEST 1: Whitelisted Google Account Login -> Must get 'Viewer'
        # -------------------------------------------------------------
        print("\n--- TEST 1: Whitelist Login & Role Assignment ---")
        login_res = eval_js(ws, """
        (function() {
            verifyAndLoginGoogleUser('auditor@jsrfinance.com', 'Auditor User');
            const u = getCurrentUser();
            return {
                role: u.role,
                user: u.user,
                route: u.route,
                isReadOnly: isCurrentUserReadOnly(),
                canEdit: canCurrentUserEdit()
            };
        })();
        """)
        print(f"Login result: {login_res}")
        assert login_res["role"] == "Viewer", f"Expected 'Viewer', got {login_res['role']}"
        assert login_res["isReadOnly"] is True, "Expected isCurrentUserReadOnly() to be True"
        assert login_res["canEdit"] is False, "Expected canCurrentUserEdit() to be False"
        print("  [PASS] Whitelist email received 'Viewer' role with isCurrentUserReadOnly = True")

        # Check UI role badge & banner
        ui_res = eval_js(ws, """
        (function() {
            updateHeaderUserBadge();
            applyRoleBasedPermissions();
            const badgeTag = (document.getElementById('sidebar-user-role') || document.getElementById('header-user-role'))?.textContent || '';
            const bannerDisplay = document.getElementById('viewer-readonly-banner')?.style.display;
            return {
                badgeTag: badgeTag,
                bannerVisible: bannerDisplay !== 'none'
            };
        })();
        """)
        print(f"UI role check: {ui_res}")
        assert ui_res["badgeTag"] == "READ ONLY", f"Expected header badge 'READ ONLY', got {ui_res['badgeTag']}"
        assert ui_res["bannerVisible"] is True, "Expected #viewer-readonly-banner to be visible"
        print("  [PASS] Topbar badge shows 'READ ONLY' and Collections banner is displayed")

        # -------------------------------------------------------------
        # TEST 2: Block Instalment Updates for Read-Only Users
        # -------------------------------------------------------------
        print("\n--- TEST 2: Blocking Instalment Modifications ---")
        inst_block_res = eval_js(ws, """
        (function() {
            // Attempt 1: toggleInstalmentReceived
            toggleInstalmentReceived('CUST-1-L1-TEST', 1);
            const cAfterToggle = state.customers.find(c => c.id === 'CUST-1-L1-TEST');
            const inst1Status = cAfterToggle.instalments[0].status;

            // Attempt 2: handleInstalmentClick
            handleInstalmentClick('CUST-1-L1-TEST', 1, null);

            // Attempt 3: handlePartialPaySubmit
            document.getElementById('partial-cust-id').value = 'CUST-1-L1-TEST';
            document.getElementById('partial-inst-num').value = '1';
            document.getElementById('partial-pay-amount').value = '100';
            handlePartialPaySubmit(null);

            const txnCount = (state.transactions || []).length;
            return {
                inst1Status: inst1Status,
                txnCount: txnCount
            };
        })();
        """)
        print(f"Instalment block result: {inst_block_res}")
        assert inst_block_res["inst1Status"] == "Pending", "Instalment must remain 'Pending'"
        assert inst_block_res["txnCount"] == 0, "No transactions should be recorded"
        print("  [PASS] All instalment payment attempts were rejected; records remained unchanged")

        # -------------------------------------------------------------
        # TEST 3: Block Customer Mutations for Read-Only Users
        # -------------------------------------------------------------
        print("\n--- TEST 3: Blocking Customer Mutations ---")
        cust_block_res = eval_js(ws, """
        (function() {
            let addModalBlocked = false;
            let editModalBlocked = false;
            let addLoanBlocked = false;
            let deleteBlocked = false;

            const origAlert = window.alert;
            window.alert = function(msg) {
                if (msg.includes('Read-Only') || msg.includes('Access Denied')) {
                    if (msg.includes('create new customers')) addModalBlocked = true;
                    if (msg.includes('modify customer terms')) editModalBlocked = true;
                    if (msg.includes('issue new loans')) addLoanBlocked = true;
                    if (msg.includes('delete')) deleteBlocked = true;
                }
            };

            openAddCustomerModal();
            openEditCustomerModal('CUST-1-L1-TEST');
            openAddLoanForCustomer('1');
            deleteCustomer('CUST-1-L1-TEST');

            window.alert = origAlert;
            const custCount = state.customers.length;
            return {
                addModalBlocked,
                editModalBlocked,
                addLoanBlocked,
                deleteBlocked,
                custCount
            };
        })();
        """)
        print(f"Customer mutation block result: {cust_block_res}")
        assert cust_block_res["addModalBlocked"] is True, "Add Customer must be blocked"
        assert cust_block_res["editModalBlocked"] is True, "Edit Customer must be blocked"
        assert cust_block_res["addLoanBlocked"] is True, "Add Loan must be blocked"
        assert cust_block_res["deleteBlocked"] is True, "Delete Customer must be blocked"
        assert cust_block_res["custCount"] == 1, "Customer must NOT be deleted"
        print("  [PASS] All customer creation, editing, loan issuing, and deletion actions were blocked")

        # -------------------------------------------------------------
        # TEST 4: Customer Detail Modal & Tables Render in View-Only
        # -------------------------------------------------------------
        print("\n--- TEST 4: View-Only UI Elements in Detail Modal & Tables ---")
        detail_ui_res = eval_js(ws, """
        (function() {
            renderCustomersTable();
            renderCustomerDetailModalContent('CUST-1-L1-TEST');
            const detailContent = document.getElementById('cust-detail-loan-content')?.innerHTML || '';
            const tableHtml = document.getElementById('customers-table-body')?.innerHTML || '';

            return {
                showsReadOnlyBadge: detailContent.includes('🔒 Read-Only Schedule'),
                hasPartialPayBtn: detailContent.includes('½ Partial Pay'),
                hasEditTermsBtn: detailContent.includes('✏️ Edit Terms'),
                tableHasEditBtn: tableHtml.includes('✏️ Edit'),
                tableHasDeleteBtn: tableHtml.includes('🗑️ Delete'),
                tableHasPassbookBtn: tableHtml.includes('🧾 Passbook')
            };
        })();
        """)
        print(f"Detail UI result: {detail_ui_res}")
        assert detail_ui_res["showsReadOnlyBadge"] is True, "Expected '🔒 Read-Only Schedule' badge"
        assert detail_ui_res["hasPartialPayBtn"] is False, "Partial pay button must be hidden"
        assert detail_ui_res["hasEditTermsBtn"] is False, "Edit terms button must be hidden"
        assert detail_ui_res["tableHasEditBtn"] is False, "Table Edit button must be hidden"
        assert detail_ui_res["tableHasDeleteBtn"] is False, "Table Delete button must be hidden"
        assert detail_ui_res["tableHasPassbookBtn"] is True, "Table Passbook button MUST remain accessible"
        print("  [PASS] Detail modal and table correctly hide mutation buttons while keeping Passbook accessible")

        # -------------------------------------------------------------
        # TEST 5: Automated Daily Midnight Backup Engine
        # -------------------------------------------------------------
        print("\n--- TEST 5: Automated Midnight Backup Snapshot Engine ---")
        backup_res = eval_js(ws, """
        (function() {
            localStorage.removeItem('jsr_last_daily_backup_date');
            checkAndCreateDailyBackupSnapshot();

            const todayStr = getISTDateString();
            const storedDate = localStorage.getItem('jsr_last_daily_backup_date');
            const storedSnapshotRaw = localStorage.getItem(`jsr_daily_backup_${todayStr}`);
            const snapshot = storedSnapshotRaw ? JSON.parse(storedSnapshotRaw) : null;
            const statusText = document.getElementById('daily-backup-status-text')?.textContent || '';

            return {
                storedDate,
                todayStr,
                hasSnapshot: Boolean(snapshot),
                customerCount: snapshot ? snapshot.customers.length : 0,
                statusActive: statusText.includes('Daily midnight snapshot active')
            };
        })();
        """)
        print(f"Backup engine result: {backup_res}")
        assert backup_res["storedDate"] == backup_res["todayStr"], "Backup date must match today's IST date"
        assert backup_res["hasSnapshot"] is True, "Snapshot JSON must exist in localStorage"
        assert backup_res["customerCount"] == 1, "Snapshot must contain customer records"
        assert backup_res["statusActive"] is True, "UI status text must confirm active snapshot"
        print("  [PASS] Daily midnight snapshot was successfully generated and verified in local storage")

        # -------------------------------------------------------------
        # TEST 6: Admin and Collector Retain Full Authorized Privileges
        # -------------------------------------------------------------
        print("\n--- TEST 6: Verifying Admin and Collector Authorized Privileges ---")
        admin_res = eval_js(ws, """
        (function() {
            verifyAndLoginGoogleUser('singarisurendra@gmail.com', 'Surendra Singari');
            const u = getCurrentUser();
            return {
                role: u.role,
                isReadOnly: isCurrentUserReadOnly(),
                canEdit: canCurrentUserEdit()
            };
        })();
        """)
        print(f"Admin login result: {admin_res}")
        assert admin_res["role"] == "Admin", "Admin must receive 'Admin' role"
        assert admin_res["isReadOnly"] is False, "Admin must NOT be read-only"
        assert admin_res["canEdit"] is True, "Admin must have edit permissions"

        collector_res = eval_js(ws, """
        (function() {
            verifyAndLoginGoogleUser('singarisurendra24@gmail.com', 'Singari Suri');
            const u = getCurrentUser();
            return {
                role: u.role,
                user: u.user,
                isReadOnly: isCurrentUserReadOnly(),
                canEdit: canCurrentUserEdit()
            };
        })();
        """)
        print(f"Collector login result: {collector_res}")
        assert collector_res["role"] == "Collector", "Collector must receive 'Collector' role"
        assert collector_res["user"] == "Singari Suri", "Collector must match roster name"
        assert collector_res["isReadOnly"] is False, "Collector must NOT be read-only"
        assert collector_res["canEdit"] is True, "Collector must have collection permissions"
        print("  [PASS] Admin and Field Collectors retain full respective authorization")

        # -------------------------------------------------------------
        # 7. Take Screenshot Proof of Read-Only Viewer Screen
        # -------------------------------------------------------------
        eval_js(ws, """
        (function() {
            verifyAndLoginGoogleUser('auditor@jsrfinance.com', 'Auditor User');
            updateHeaderUserBadge();
            applyRoleBasedPermissions();
            renderCustomersTable();
            renderCollectionMatrix();
        })();
        """)
        time.sleep(1.0)
        shot_id = ws.send("Page.captureScreenshot", {"format": "png"})
        shot_res = ws.recv_msg(target_id=shot_id)
        if shot_res and "result" in shot_res and "data" in shot_res["result"]:
            png_bytes = base64.b64decode(shot_res["result"]["data"])
            shot_path = os.path.join(ARTIFACT_DIR, "verified_readonly_and_backup.png")
            with open(shot_path, "wb") as f:
                f.write(png_bytes)
            print(f"[*] Saved verification screenshot to: {shot_path}")

        print("\n" + "=" * 70)
        print("  ALL 6 TESTS PASSED SUCCESSFULLY! (Code 0)")
        print("=" * 70)
        return 0

    except Exception as e:
        print(f"\n[!] Verification encountered error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        if ws:
            try: ws.s.close()
            except: pass
        if proc:
            proc.kill()
        server.shutdown()

if __name__ == "__main__":
    sys.exit(main())
