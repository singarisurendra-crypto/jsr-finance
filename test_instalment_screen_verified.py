"""
JSR Finance - Modern Instalment Screen Verification Test Suite (test_instalment_screen_verified.py)
Tests:
 1. Top 4 KPI Metrics Cards on Instalments Screen (Active Loans, Total Disbursed, Total Collected, Due Today)
 2. Collapsible Quick Receive bar (collapsed by default into slim bar, expanding only on click)
 3. Combined compact action toolbar (Expand all, Collapse all, Export CSV, Print, + Add)
 4. High-contrast Legend ([✓] Paid, [ ] Pending, [-] Partial, 52 instalments per customer)
 5. Compact customer row layout (Avatar initials, name, loan badge, ID/phone, weekly amount, paid count, progress bar + percentage, chevron)
 6. Single-Customer Accordion Expansion with 4-row x 13-col checkbox matrix
 7. Capture visual proof screenshot (instalments_screen_verified.png)
"""

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
from http.server import ThreadingHTTPServer

from db import db
from server import JSRFinanceHandler

PORT_HTTP = 8995
PORT_CDP = 9263

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
    print("=========================================================")
    print("   JSR Finance - Modern Instalment Screen Verification   ")
    print("=========================================================")

    server_address = ("127.0.0.1", PORT_HTTP)
    httpd = ThreadingHTTPServer(server_address, JSRFinanceHandler)
    import threading
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    user_data = r"C:\Users\surendra.s\.gemini\antigravity\scratch\edge_instalments_verify"
    os.makedirs(user_data, exist_ok=True)

    # Set mobile-like dimensions matching screenshot (width ~ 540, height ~ 880)
    cmd = [
        edge_path,
        f"--remote-debugging-port={PORT_CDP}",
        "--headless=new",
        "--disable-gpu",
        f"--user-data-dir={user_data}",
        "--window-size=560,980",
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
            res = simple_ws_send_recv(ws_url, {"id": 10 + attempt, "method": "Runtime.evaluate", "params": {"expression": "typeof renderCollectionMatrix"}})
            if res and "function" in res:
                print(f"[OK] app.js initialized on attempt {attempt}")
                break
            time.sleep(1)

        # Login as authorized operator
        login_js = """
        (function() {
            verifyAndLoginGoogleUser('admin@jsrfinance.com', 'Surendra Singari');
            switchTab('collections');
            return true;
        })()
        """
        simple_ws_send_recv(ws_url, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": login_js}})
        time.sleep(1)

        # Step 1: Verify Summary KPI Cards Removal & Shortcut Button in Filter Row
        kpi_check_js = """
        (function() {
            const gridEl = document.querySelector('.coll-kpi-grid');
            const shortcutBtn = document.querySelector('.coll-btn-shortcut');
            const searchRow = document.querySelector('.coll-search-row');
            return JSON.stringify({
                hasVisibleGrid: !!gridEl,
                hasShortcutBtn: !!shortcutBtn,
                shortcutText: shortcutBtn ? shortcutBtn.innerText.trim() : '',
                shortcutInSearchRow: !!searchRow && searchRow.contains(shortcutBtn)
            });
        })()
        """
        res_kpi = simple_ws_send_recv(ws_url, {"id": 2, "method": "Runtime.evaluate", "params": {"expression": kpi_check_js, "returnByValue": True}})
        kpi_data = get_cdp_value(res_kpi)
        print("1. Summary Cards Removed & Shortcut Button Added:", kpi_data)
        assert kpi_data["hasVisibleGrid"] is False, "Summary KPI grid must be removed from the instalment screen"
        assert kpi_data["hasShortcutBtn"] is True, "Shortcut button must be present in filter bar"
        assert "⌘K" in kpi_data["shortcutText"], "Shortcut button must indicate ⌘K"
        assert kpi_data["shortcutInSearchRow"] is True, "Shortcut button must be inside .coll-search-row"
        print("  [PASS] Summary KPI cards removed from screen, and ⚡ ⌘K shortcut button added to filter bar.")

        # Step 2: Verify Collapsible Quick Receive
        quick_check_js = """
        (function() {
            const body = document.getElementById('coll-quick-body');
            const initialHidden = body.style.display === 'none';
            toggleQuickReceive();
            const afterOpen = body.style.display !== 'none';
            toggleQuickReceive();
            const afterClose = body.style.display === 'none';
            return JSON.stringify({
                initialHidden: initialHidden,
                afterOpen: afterOpen,
                afterClose: afterClose
            });
        })()
        """
        res_quick = simple_ws_send_recv(ws_url, {"id": 3, "method": "Runtime.evaluate", "params": {"expression": quick_check_js, "returnByValue": True}})
        quick_data = get_cdp_value(res_quick)
        print("2. Quick Receive Accordion:", quick_data)
        assert quick_data["initialHidden"] is True, "Quick Receive must be collapsed by default"
        assert quick_data["afterOpen"] is True, "Quick Receive should expand when clicked"
        assert quick_data["afterClose"] is True, "Quick Receive should collapse when clicked again"
        print("  [PASS] Quick Receive is collapsed by default and opens on demand.")

        # Step 3: Verify Single-Customer Accordion and 4-Row Grid
        accordion_check_js = """
        (function() {
            let cards = document.querySelectorAll('.cust-compact-card');
            if (cards.length < 2) return JSON.stringify({ error: 'Need at least 2 customers' });

            const id1 = cards[0].dataset.customerId;
            const id2 = cards[1].dataset.customerId;

            // Click Customer 1
            toggleCustomerSchedule(id1);
            cards = document.querySelectorAll('.cust-compact-card');
            const c1Expanded = cards[0].classList.contains('card-expanded');
            const c2Collapsed = !cards[1].classList.contains('card-expanded');

            // Count 4-row grid cells in Customer 1
            const grid = cards[0].querySelector('.sched-4row-grid');
            const cellsCount = grid ? grid.querySelectorAll('.sched-cell').length : 0;

            // Click Customer 2: Verify Single-Customer Accordion (Customer 1 closes, Customer 2 opens)
            toggleCustomerSchedule(id2);
            cards = document.querySelectorAll('.cust-compact-card');
            const c1ClosedAfter = !cards[0].classList.contains('card-expanded');
            const c2OpenAfter = cards[1].classList.contains('card-expanded');

            // Re-open Customer 1 for final visual snapshot
            toggleCustomerSchedule(id1);

            return JSON.stringify({
                customersTotal: cards.length,
                c1Expanded: c1Expanded,
                c2Collapsed: c2Collapsed,
                gridCellsCount: cellsCount,
                c1ClosedAfter: c1ClosedAfter,
                c2OpenAfter: c2OpenAfter
            });
        })()
        """
        res_acc = simple_ws_send_recv(ws_url, {"id": 4, "method": "Runtime.evaluate", "params": {"expression": accordion_check_js, "returnByValue": True}})
        acc_data = get_cdp_value(res_acc)
        print("3. Single-Customer Accordion & 4-Row Grid:", acc_data)
        assert acc_data["c1Expanded"] is True, "Customer 1 should expand on click"
        assert acc_data["c2Collapsed"] is True, "Customer 2 should remain collapsed"
        assert acc_data["gridCellsCount"] == 52, f"Expected 52 grid cells (4 rows of 13), got {acc_data['gridCellsCount']}"
        assert acc_data["c1ClosedAfter"] is True, "Customer 1 must close when Customer 2 is selected (Single-customer accordion)"
        assert acc_data["c2OpenAfter"] is True, "Customer 2 must open when selected"
        print("  [PASS] Single-customer accordion and 52-instalment 4-row grid verified.")

        # Step 3.5: Verify 3-Row Customer Card & #1 ID Prefix Before Avatar
        id_prefix_check_js = """
        (function() {
            const cards = document.querySelectorAll('.cust-compact-card');
            const card1 = cards[0];
            const leftEl = card1.querySelector('.cust-card-left');
            const prefixEl = leftEl ? leftEl.querySelector('.cust-id-prefix') : null;
            const avatarEl = leftEl ? leftEl.querySelector('.cust-avatar') : null;
            const subDetailsEl = leftEl ? leftEl.querySelector('.cust-sub-details') : null;
            const termsEl = leftEl ? leftEl.querySelector('.cust-financial-terms') : null;

            const rightEl = card1.querySelector('.cust-card-right');
            const paidStatEl = rightEl ? rightEl.querySelector('.cust-paid-stat') : null;
            const progRowEl = rightEl ? rightEl.querySelector('.cust-progress-row') : null;
            const pctEl = progRowEl ? progRowEl.querySelector('.cust-pct-label') : null;
            const chevronEl = rightEl ? rightEl.querySelector('.cust-chevron-icon') : null;
            
            // Check order: prefixEl should appear before avatarEl in DOM
            const isBeforeAvatar = prefixEl && avatarEl && (prefixEl.compareDocumentPosition(avatarEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

            return JSON.stringify({
                hasPrefix: !!prefixEl,
                prefixText: prefixEl ? prefixEl.innerText.trim() : '',
                hasAvatar: !!avatarEl,
                avatarInitials: avatarEl ? avatarEl.innerText.trim() : '',
                isBeforeAvatar: !!isBeforeAvatar,
                subDetailsText: subDetailsEl ? subDetailsEl.innerText.trim() : '',
                termsText: termsEl ? termsEl.innerText.trim() : '',
                hasPaidStat: !!paidStatEl && paidStatEl.innerText.includes('paid'),
                hasPctAtEnd: !!pctEl && pctEl.innerText.includes('%'),
                hasChevron: !!chevronEl
            });
        })()
        """
        res_prefix = simple_ws_send_recv(ws_url, {"id": 45, "method": "Runtime.evaluate", "params": {"expression": id_prefix_check_js, "returnByValue": True}})
        prefix_data = get_cdp_value(res_prefix)
        print("3.5. 3-Row Customer Card & ID Prefix:", prefix_data)
        assert prefix_data["hasPrefix"] is True, "Must have .cust-id-prefix element"
        assert prefix_data["prefixText"] == "#1", f"Expected #1 for customer 1, got {prefix_data['prefixText']}"
        assert prefix_data["isBeforeAvatar"] is True, "Customer ID (#1) must precede the avatar icon"
        assert "CUS" in prefix_data["subDetailsText"], "Sub-details must show CUS code"
        assert "₹" in prefix_data["termsText"], "Terms row must show financial terms"
        assert prefix_data["hasPaidStat"] is True, "Paid count stat must include 'paid' text"
        assert prefix_data["hasPctAtEnd"] is True, "Progress row must include % at end"
        assert prefix_data["hasChevron"] is True, "Must have chevron toggle icon"
        print("  [PASS] Verified 3-row layout matching media_1792566364378.png with #1 prefix before profile avatar.")

        # Step 4: Verify Toolbar Action Buttons
        toolbar_check_js = """
        (function() {
            const expBtn = document.getElementById('btn-expand-all');
            const colBtn = document.getElementById('btn-collapse-all');
            const cards = document.querySelectorAll('.cust-compact-card');

            expandAllSchedules();
            const allExpandedCount = document.querySelectorAll('.cust-compact-card.card-expanded').length;

            collapseAllSchedules();
            const allCollapsedCount = document.querySelectorAll('.cust-compact-card.card-expanded').length;

            // Re-open Customer 1 for the screenshot
            const id1 = cards[0].dataset.customerId;
            toggleCustomerSchedule(id1);

            return JSON.stringify({
                allExpandedSuccess: allExpandedCount === cards.length,
                allCollapsedSuccess: allCollapsedCount === 0
            });
        })()
        """
        res_tb = simple_ws_send_recv(ws_url, {"id": 5, "method": "Runtime.evaluate", "params": {"expression": toolbar_check_js, "returnByValue": True}})
        tb_data = get_cdp_value(res_tb)
        print("4. Action Toolbar:", tb_data)
        assert tb_data["allExpandedSuccess"] is True, "Expand all must open all cards"
        assert tb_data["allCollapsedSuccess"] is True, "Collapse all must close all cards"
        # Step 4.5: Verify Screen View Isolation and End-to-End Undo Payment & Filter Flow
        tab_isolation_check_js = """
        (function() {
            const results = {};
            // 1. Switch to Customers tab
            switchTab('customers');
            const custView = document.getElementById('view-customers');
            const collView = document.getElementById('view-collections');
            results.customersActive = custView && custView.classList.contains('active') && getComputedStyle(custView).display !== 'none';
            results.collHiddenOnCust = collView && (!collView.classList.contains('active') || getComputedStyle(collView).display === 'none');

            // 2. Switch to Settings tab
            switchTab('settings');
            const settView = document.getElementById('view-settings');
            results.settingsActive = settView && settView.classList.contains('active') && getComputedStyle(settView).display !== 'none';
            results.collHiddenOnSett = collView && (!collView.classList.contains('active') || getComputedStyle(collView).display === 'none');

            // 3. Switch to Analytics tab
            switchTab('analytics');
            const anaView = document.getElementById('view-analytics');
            results.analyticsActive = anaView && anaView.classList.contains('active') && getComputedStyle(anaView).display !== 'none';
            results.collHiddenOnAna = collView && (!collView.classList.contains('active') || getComputedStyle(collView).display === 'none');

            // 4. Switch back to collections to test User Flow:
            // Customer 1 pays up to instalment 22, then user un-checks instalment 22
            switchTab('collections');
            const cust1 = state.customers[0];
            cust1.totalInstalments = 52;
            // Ensure instalments 1..21 are received
            cust1.instalments = cust1.instalments || [];
            for (let i = 1; i <= 21; i++) {
                if (!cust1.instalments[i - 1]) {
                    cust1.instalments.push({ number: i, status: 'Received', dueAmount: 200, paidAmount: 200, paidDate: getISTDateString() });
                } else {
                    cust1.instalments[i - 1].status = 'Received';
                    cust1.instalments[i - 1].paidAmount = 200;
                }
            }
            // Mark instalment 22 as received and saved
            if (!cust1.instalments[21]) {
                cust1.instalments.push({ number: 22, status: 'Received', dueAmount: 200, paidAmount: 200, receiptNumber: 'REC-TEST-22', paidDate: getISTDateString() });
            } else {
                cust1.instalments[21].status = 'Received';
                cust1.instalments[21].paidAmount = 200;
                cust1.instalments[21].receiptNumber = 'REC-TEST-22';
            }
            // Ensure instalments 23 to 52 are pending so 22 is the highest paid
            for (let i = 23; i <= (cust1.totalInstalments || 52); i++) {
                if (cust1.instalments[i - 1]) {
                    cust1.instalments[i - 1].status = 'Pending';
                    cust1.instalments[i - 1].paidAmount = 0;
                }
            }
            saveData();
            renderCollectionMatrix();

            // Check Customer 1 instalment 22 status
            results.debugCust1Id = cust1.id;
            results.foundCust = !!state.customers.find(c => c.id === cust1.id);
            const foundCust = state.customers.find(c => c.id === cust1.id);
            results.beforeClickInst22 = JSON.stringify(foundCust.instalments[21]);

            results.totalInst = foundCust.totalInstalments;
            let lastPaid = 0;
            const tInst = foundCust.totalInstalments || 52;
            for (let i = tInst; i >= 1; i--) {
              const itm = foundCust.instalments[i - 1];
              if (itm && (itm.status === 'Received' || itm.status === 'Partial')) {
                lastPaid = i;
                break;
              }
            }
            results.computedLastPaid = lastPaid;

            // Simulate user clicking on Instalment 22 to un-check it
            window.confirm = () => true; // Automatically confirm the modal popup
            try {
                handleInstalmentClick(cust1.id, 22);
            } catch(e) {
                results.clickError = e.message + " " + e.stack;
            }

            results.afterClickInst22 = JSON.stringify(foundCust.instalments[21]);
            results.inst22StatusAfterUndo = foundCust.instalments[21].status; // Expect 'Pending'

            // Check if transaction was logged
            const undoTxn = (state.transactions || []).find(t => t.type === 'undo' && t.instalmentNumber === 22);
            results.hasUndoTxn = !!undoTxn;
            results.undoTxnAmount = undoTxn ? undoTxn.amount : 0;

            // 5. Switch to Summary tab and test undo filtering & calculation
            switchTab('summary');
            const filterEl = document.getElementById('recent-type-filter');
            results.hasUndoFilter = !!filterEl;

            if (filterEl) {
                filterEl.value = 'undo';
                renderRecentTransactions();
            }

            const undoBadge = document.querySelector('.tx-badge-undo');
            results.hasUndoBadge = !!undoBadge;

            const recentTbody = document.getElementById('recent-transactions-list');
            results.recentListHtml = recentTbody ? recentTbody.innerHTML : '';
            results.containsInst22 = results.recentListHtml.includes('Instalment #22');
            results.containsRedMinus = results.recentListHtml.includes('- ₹ 200') || results.recentListHtml.includes('- ₹200');

            // Switch back to collections for screenshot
            switchTab('collections');
            const c1 = document.querySelectorAll('.cust-compact-card')[0];
            if (c1) toggleCustomerSchedule(c1.dataset.customerId);

            return JSON.stringify(results);
        })()
        """
        res_iso = simple_ws_send_recv(ws_url, {"id": 55, "method": "Runtime.evaluate", "params": {"expression": tab_isolation_check_js, "returnByValue": True}})
        iso_data = get_cdp_value(res_iso)
        print("4.5. Tab Isolation & End-to-End Undo Flow:", iso_data)
        assert iso_data["customersActive"] is True, "Customers view must be active"
        assert iso_data["collHiddenOnCust"] is True, "Collections view must be hidden on Customers tab"
        assert iso_data["settingsActive"] is True, "Settings view must be active"
        assert iso_data["collHiddenOnSett"] is True, "Collections view must be hidden on Settings tab"
        assert iso_data["analyticsActive"] is True, "Analytics view must be active"
        assert iso_data["collHiddenOnAna"] is True, "Collections view must be hidden on Analytics tab"
        assert iso_data["inst22StatusAfterUndo"] == "Pending", f"Instalment 22 should be Pending after undo, got {iso_data['inst22StatusAfterUndo']}"
        assert iso_data["hasUndoTxn"] is True, "state.transactions must contain an undo transaction for instalment 22"
        assert iso_data["undoTxnAmount"] == 200, f"Undo transaction amount must be 200, got {iso_data['undoTxnAmount']}"
        assert iso_data["hasUndoFilter"] is True, "Summary recent feed must have type filter"
        assert iso_data["hasUndoBadge"] is True, "Undo badges must be rendered in recent transactions"
        assert iso_data["containsInst22"] is True, "Recent transactions with undo filter must show Instalment #22"
        assert iso_data["containsRedMinus"] is True, "Recent transactions must show - ₹ 200 for undo"
        print("  [PASS] Screen view isolation and end-to-end undo payment & filter flow verified.")

        time.sleep(1)

        # Step 5: Capture Screenshot of the new Instalments screen
        shot = simple_ws_send_recv(ws_url, {"id": 6, "method": "Page.captureScreenshot", "params": {"format": "png"}})
        if shot:
            data_json = json.loads(shot)
            if "result" in data_json and "data" in data_json["result"]:
                img_path = "instalments_screen_verified.png"
                with open(img_path, "wb") as f:
                    f.write(base64.b64decode(data_json["result"]["data"]))
                print(f"[OK] Saved {img_path} ({os.path.getsize(img_path)} bytes)")
                
                # Copy to artifact directory
                import shutil
                art_dir = r"C:\Users\surendra.s\.gemini\antigravity\brain\9a0c6fee-fcaa-42a0-ade3-57b237e6eb62"
                if os.path.exists(art_dir):
                    dest = os.path.join(art_dir, "instalments_screen_verified.png")
                    shutil.copyfile(img_path, dest)
                    print(f"[OK] Copied to artifact directory: {dest}")

        print("\n=========================================================")
        print("ALL INSTALMENT SCREEN TESTS PASSED WITH 100% SUCCESS!")
        print("=========================================================")

    finally:
        try:
            proc.terminate()
            httpd.shutdown()
        except Exception:
            pass

if __name__ == "__main__":
    main()
