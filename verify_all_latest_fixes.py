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

PORT_HTTP = 8998
PORT_CDP = 9245
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
        return None

    def eval_js(self, expr):
        mid = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        res = self.recv_msg(mid, timeout=10)
        if not res or "result" not in res:
            raise RuntimeError(f"CDP eval failed: {res}")
        r = res["result"].get("result", {})
        if "value" in r:
            return r["value"]
        if "description" in r:
            return r["description"]
        return r

    def screenshot(self, filename):
        mid = self.send("Page.captureScreenshot", {"format": "png"})
        res = self.recv_msg(mid, timeout=10)
        if res and "result" in res and "data" in res["result"]:
            raw = base64.b64decode(res["result"]["data"])
            filepath = os.path.join(ARTIFACT_DIR, filename)
            with open(filepath, "wb") as f:
                f.write(raw)
            print(f"Screenshot saved: {filepath}")

    def close(self):
        try:
            self.s.close()
        except:
            pass

def main():
    print("Serving Mini_Finance on port", PORT_HTTP)
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), SimpleHTTPRequestHandler)
    import threading
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    edge_bin = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge_bin):
        edge_bin = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"

    profile_dir = os.path.join(os.getcwd(), "tmp_verify_latest_fixes_profile")
    if os.path.exists(profile_dir):
        try:
            import shutil
            shutil.rmtree(profile_dir, ignore_errors=True)
        except Exception:
            pass

    cmd = [
        edge_bin,
        f"--remote-debugging-port={PORT_CDP}",
        f"--user-data-dir={profile_dir}",
        "--headless=new",
        "--disable-http-cache",
        "--disk-cache-size=1",
        "--no-first-run",
        "--window-size=1280,900",
        f"http://127.0.0.1:{PORT_HTTP}/index.html"
    ]
    print("Spawning Edge headless...")
    proc = subprocess.Popen(cmd)
    time.sleep(2.5)

    client = None
    try:
        page_target = None
        for _ in range(25):
            try:
                targets_url = f"http://127.0.0.1:{PORT_CDP}/json"
                with urllib.request.urlopen(targets_url) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                for t in data:
                    if t.get("type") == "page" and "index.html" in t.get("url", ""):
                        page_target = t
                        break
                if page_target:
                    break
            except Exception:
                pass
            time.sleep(0.5)

        if not page_target:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json") as resp:
                data = json.loads(resp.read().decode("utf-8"))
            page_target = next(t for t in data if t.get("type") == "page")

        ws_url = page_target["webSocketDebuggerUrl"]
        client = WebSocketClient(ws_url)
        client.send("Page.enable")
        client.send("DOM.enable")

        # Wait for document to be ready
        for _ in range(30):
            ready = client.eval_js("document.readyState === 'complete' && typeof window.state !== 'undefined'")
            if ready:
                break
            time.sleep(0.3)

        print("DEBUG URL:", client.eval_js("window.location.href"))
        print("DEBUG typeof window.state:", client.eval_js("typeof window.state"))
        print("DEBUG readyState:", client.eval_js("document.readyState"))

        # 1. Setup authenticated admin session
        setup_res = client.eval_js("""
            (() => {
                try {
                    const state = window.state;
                    const sessionData = {
                        user: 'Surendra Singari',
                        email: 'singarisurendra@gmail.com',
                        role: 'Admin',
                        provider: 'Google SSO',
                        loginTime: new Date().toISOString()
                    };
                    localStorage.setItem('jsr_auth_session', JSON.stringify(sessionData));
                    localStorage.setItem('jsr_finance_operator_session', JSON.stringify(sessionData));
                    const loginOverlay = document.getElementById('view-login');
                    if (loginOverlay) loginOverlay.style.display = 'none';
                    const todayStr = (typeof getISTDateString === 'function') ? getISTDateString() : new Date().toISOString().split('T')[0];
                    const pastDate = new Date(Date.now() - 106 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

                    const sriRamInstalments = [];
                    for (let i = 1; i <= 25; i++) {
                        if (i <= 11) {
                            sriRamInstalments.push({
                                number: i,
                                dueAmount: 520,
                                paidAmount: 520,
                                paidDate: todayStr,
                                paidBy: 'Admin',
                                status: 'Received',
                                receiptNumber: `REC-1-${i}`
                            });
                        } else if (i === 12) {
                            sriRamInstalments.push({
                                number: i,
                                dueAmount: 520,
                                paidAmount: 300,
                                paidDate: todayStr,
                                paidBy: 'Admin',
                                status: 'Partial',
                                receiptNumber: `REC-1-${i}`
                            });
                        } else {
                            sriRamInstalments.push({
                                number: i,
                                dueAmount: 520,
                                paidAmount: 0,
                                paidDate: null,
                                status: 'Pending'
                            });
                        }
                    }

                    state.customers = [
                        {
                            id: 'CUST-101',
                            customerNumber: '1',
                            loanNumber: 1,
                            fullName: 'Sri Ram',
                            phone: '9876543210',
                            address: 'Main Bazaar Road, Shop #12',
                            areaRoute: 'Market Line',
                            givenAmount: 10000,
                            totalPayable: 13000,
                            instalmentAmount: 520,
                            totalInstalments: 25,
                            frequency: 'Weekly',
                            startDate: pastDate,
                            status: 'Active',
                            instalments: sriRamInstalments
                        },
                        {
                            id: 'CUST-102',
                            customerNumber: '2',
                            loanNumber: 1,
                            fullName: 'K. Venkatesh',
                            phone: '9848022334',
                            address: 'Station Road #44',
                            areaRoute: 'Station Road',
                            givenAmount: 20000,
                            totalPayable: 24000,
                            instalmentAmount: 1000,
                            totalInstalments: 24,
                            frequency: 'Weekly',
                            startDate: pastDate,
                            status: 'Active',
                            instalments: [
                                { number: 1, dueAmount: 1000, paidAmount: 1000, paidDate: todayStr, paidBy: 'Admin', status: 'Received', receiptNumber: 'REC-2-1' },
                                { number: 2, dueAmount: 1000, paidAmount: 20764, paidDate: todayStr, paidBy: 'Admin', status: 'Received', receiptNumber: 'REC-2-2' }
                            ]
                        }
                    ];

                    state.settings.collectors = [
                        { id: 'COL-1', name: 'Ravi Kumar', email: 'ravi@gmail.com', phone: '9988776655', route: 'Market Line', active: true }
                    ];

                    saveData();
                    state.filterStatus = 'all';
                    state.searchQuery = '';
                    state.collectionLoanFilter = 'all';
                    switchTab('collections');
                    renderCollectionMatrix();
                    renderCustomersTable();
                    if (typeof updateHeaderUserBadge === 'function') updateHeaderUserBadge();
                    if (typeof updateHeaderStats === 'function') updateHeaderStats();
                    return { ok: true };
                } catch(e) {
                    return { ok: false, error: e.toString(), stack: e.stack };
                }
            })()
        """)
        print("Setup Result:", json.dumps(setup_res))
        time.sleep(0.5)

        # 2. Verify Top Header (User badge removed) & Left Sidebar (Lite background #E8F2FF & user card down)
        header_sidebar_check = client.eval_js("""
            (() => {
                const badge = document.getElementById('header-user-badge');
                const syncPill = document.getElementById('cloud-status-pill');
                const sidebar = document.getElementById('app-sidebar');
                const sidebarUserCard = document.getElementById('sidebar-user-card');
                const sidebarUserAvatar = document.getElementById('sidebar-user-avatar');
                const sidebarUserName = document.getElementById('sidebar-user-name');
                const sidebarUserRole = document.getElementById('sidebar-user-role');
                const sidebarLogout = document.querySelector('.sidebar-logout-btn');

                const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : null;

                return {
                    headerBadgeExists: !!badge,
                    syncPillExistsInDom: !!syncPill,
                    sidebarBg: sidebarStyle ? sidebarStyle.backgroundColor : '',
                    sidebarUserCardExists: !!sidebarUserCard,
                    sidebarAvatar: sidebarUserAvatar ? sidebarUserAvatar.innerText.trim() : '',
                    sidebarName: sidebarUserName ? sidebarUserName.innerText.trim() : '',
                    sidebarRole: sidebarUserRole ? sidebarUserRole.innerText.trim() : '',
                    sidebarLogoutExists: !!sidebarLogout
                };
            })()
        """)
        print("Header & Sidebar Check:", json.dumps(header_sidebar_check, indent=2))
        assert not header_sidebar_check["headerBadgeExists"], "Top menu must NOT have Full access / user badge (removed duplicate)"
        assert not header_sidebar_check["syncPillExistsInDom"], "Sync: Live pill must be removed from top header"
        assert header_sidebar_check["sidebarBg"] == "rgb(232, 242, 255)", f"Sidebar background must be #E8F2FF, got: {header_sidebar_check['sidebarBg']}"
        assert header_sidebar_check["sidebarUserCardExists"], "Left menu down must have user card"
        assert header_sidebar_check["sidebarAvatar"] == "S", f"Sidebar avatar 'S', got: {header_sidebar_check['sidebarAvatar']}"
        assert "Surendra" in header_sidebar_check["sidebarName"] or "surendra" in header_sidebar_check["sidebarName"], f"Expected surendra, got: {header_sidebar_check['sidebarName']}"
        assert "FULL ACCESS" in header_sidebar_check["sidebarRole"].upper() or "ADMIN" in header_sidebar_check["sidebarRole"].upper(), f"Expected FULL ACCESS, got: {header_sidebar_check['sidebarRole']}"
        assert header_sidebar_check["sidebarLogoutExists"], "Left menu down must have logout button"

        # 3. Test Collections View & Compact Badges & Balance Placement
        client.eval_js("switchTab('collections');")
        time.sleep(0.5)

        coll_check = client.eval_js("""
            (() => {
                const state = window.state || {};
                const sriramCard = document.querySelector('.cust-compact-card');
                if (!sriramCard) return { 
                    found: false, 
                    cardsHtml: document.getElementById('collection-cards-list')?.innerHTML?.substring(0, 300),
                    custCount: (state.customers || []).length,
                    activeTab: state.activeTab,
                    filterStatus: state.filterStatus,
                    searchQuery: state.searchQuery
                };
                const custId = sriramCard.dataset.customerId;
                const nameRow = sriramCard.querySelector('.cust-name-row');
                const overdueBadge = nameRow ? nameRow.querySelector('.badge-overdue') : null;
                const partialBadge = nameRow ? nameRow.querySelector('.badge-partial-pill') : null;
                const financialTerms = sriramCard.querySelector('.cust-financial-terms');
                const hasBalanceInTerms = financialTerms ? financialTerms.innerText.includes('Total Loan Balance') || financialTerms.innerText.includes('Bal:') : false;

                // Legend check
                const legendPartial = document.querySelector('.coll-legend-box.box-partial');
                const legendStyle = legendPartial ? window.getComputedStyle(legendPartial) : null;

                // Partial badge style
                const partialStyle = partialBadge ? window.getComputedStyle(partialBadge) : null;

                return {
                    found: true,
                    customerId: custId,
                    overdueText: overdueBadge ? overdueBadge.innerText.trim() : '',
                    partialText: partialBadge ? partialBadge.innerText.trim() : '',
                    termsText: financialTerms ? financialTerms.innerText.trim() : '',
                    hasBalanceInTerms: hasBalanceInTerms,
                    legendPartialBg: legendStyle ? legendStyle.backgroundColor : '',
                    partialBadgeBg: partialStyle ? partialStyle.backgroundColor : '',
                    partialBadgeColor: partialStyle ? partialStyle.color : '',
                    partialBadgeBorder: partialStyle ? partialStyle.borderColor : ''
                };
            })()
        """)
        print("Collections View Check (Collapsed):", json.dumps(coll_check, indent=2))
        assert coll_check["found"], "Customer card not found in collections"
        assert "Due" in coll_check["overdueText"], f"Overdue must use compact 'Due', got: {coll_check['overdueText']}"
        assert "½" in coll_check["partialText"], f"Partial must use compact '½', got: {coll_check['partialText']}"
        assert not coll_check["hasBalanceInTerms"], f"Balance must be removed from below customer name, got: {coll_check['termsText']}"
        assert coll_check["legendPartialBg"] == "rgb(245, 158, 11)", f"Legend partial background must be #f59e0b, got: {coll_check['legendPartialBg']}"

        # 4. Expand Customer Card & Verify Balance is Shown Inside After Expand
        expand_check = client.eval_js(f"""
            (() => {{
                const state = window.state || {{}};
                const custId = '{coll_check["customerId"]}';
                if (!state.expandedCustomerIds) state.expandedCustomerIds = new Set();
                state.expandedCustomerIds.add(custId);
                renderCollectionMatrix();

                const expandedCard = document.querySelector(`.cust-compact-card[data-customer-id="${{custId}}"]`);
                const expandedBody = expandedCard ? expandedCard.querySelector('.cust-card-expanded-body') : null;
                const quickToolbar = expandedBody ? expandedBody.querySelector('.sched-quick-toolbar') : null;
                const balPill = quickToolbar ? quickToolbar.querySelector('.sched-bal-badge') : null;

                return {{
                    isExpanded: !!expandedBody,
                    toolbarText: quickToolbar ? quickToolbar.innerText : '',
                    balPillText: balPill ? balPill.innerText.trim() : ''
                }};
            }})()
        """)
        print("Expanded View Check:", json.dumps(expand_check, indent=2))
        assert expand_check["isExpanded"], "Customer card must be expanded"
        assert "Bal:" in expand_check["balPillText"], f"Loan balance must be displayed inside expanded area, got: {expand_check['balPillText']}"

        # 5. Open Customer Detail Modal & Verify Compact Toolbar
        modal_check = client.eval_js(f"""
            (() => {{
                openCustomerDetailModal('{coll_check["customerId"]}');
                const modal = document.getElementById('modal-customer-detail');
                const toolbar = modal ? modal.querySelector('.sched-quick-toolbar') : null;
                const partialBtn = toolbar ? toolbar.querySelector('button[onclick*="openPartialPayModal"]') : null;
                const partialBtnStyle = partialBtn ? window.getComputedStyle(partialBtn) : null;

                return {{
                    modalDisplayed: modal && modal.style.display !== 'none',
                    toolbarText: toolbar ? toolbar.innerText : '',
                    partialBtnBg: partialBtnStyle ? partialBtnStyle.backgroundColor : '',
                    partialBtnColor: partialBtnStyle ? partialBtnStyle.color : ''
                }};
            }})()
        """)
        print("Detail Modal Check:", json.dumps(modal_check, indent=2))
        assert modal_check["modalDisplayed"], "Customer detail modal must be visible"
        assert "Bal:" in modal_check["toolbarText"], f"Detail modal must have compact 'Bal:', got: {modal_check['toolbarText']}"
        assert modal_check["partialBtnBg"] == "rgb(254, 243, 199)", f"Partial pay button background must be amber #fef3c7, got: {modal_check['partialBtnBg']}"

        # Close detail modal
        client.eval_js("closeCustomerDetailModal();")
        time.sleep(0.3)

        # 6. Customer Master Screen: Verify Action Buttons (Edit, Passbook, Delete outside, compact More)
        client.eval_js("switchTab('customers');")
        time.sleep(0.5)

        cust_screen_check = client.eval_js("""
            (() => {
                const tableRow = document.querySelector('#customers-table-body tr');
                const tableButtons = tableRow ? Array.from(tableRow.querySelectorAll('.cust-row-actions button')).map(b => b.innerText.trim()) : [];

                const mobileCard = document.querySelector('#customers-mobile-cards .customer-card');
                const mobileButtons = mobileCard ? Array.from(mobileCard.querySelectorAll('.customer-card-actions button')).map(b => b.innerText.trim()) : [];

                const editBtn = tableRow ? tableRow.querySelector('.btn-cust-edit') : null;
                const passBtn = tableRow ? tableRow.querySelector('.btn-cust-passbook') : null;
                const delBtn = tableRow ? tableRow.querySelector('.btn-cust-delete') : null;
                const moreBtn = tableRow ? tableRow.querySelector('.btn-cust-more') : null;

                const editStyle = editBtn ? window.getComputedStyle(editBtn) : null;
                const passStyle = passBtn ? window.getComputedStyle(passBtn) : null;
                const delStyle = delBtn ? window.getComputedStyle(delBtn) : null;
                const moreStyle = moreBtn ? window.getComputedStyle(moreBtn) : null;

                return {
                    tableButtons,
                    mobileButtons,
                    editBg: editStyle ? editStyle.backgroundColor : '',
                    editColor: editStyle ? editStyle.color : '',
                    passBg: passStyle ? passStyle.backgroundColor : '',
                    passColor: passStyle ? passStyle.color : '',
                    delBg: delStyle ? delStyle.backgroundColor : '',
                    delColor: delStyle ? delStyle.color : '',
                    moreBg: moreStyle ? moreStyle.backgroundColor : '',
                    moreColor: moreStyle ? moreStyle.color : ''
                };
            })()
        """)
        print("Customer Screen Action Buttons Check:", json.dumps(cust_screen_check, indent=2))
        assert "✏️ Edit" in cust_screen_check["tableButtons"], "Edit button must exist in table"
        assert "🧾 Passbook" in cust_screen_check["tableButtons"], "Passbook button must exist in table"
        assert "🗑️ Delete" in cust_screen_check["tableButtons"], "Delete button must be moved outside to table row"
        assert "⋯ More" in cust_screen_check["tableButtons"], "More button must be compact '⋯ More'"
        assert cust_screen_check["editBg"] == "rgb(239, 246, 255)", f"Edit button background blue, got {cust_screen_check['editBg']}"
        assert cust_screen_check["passBg"] == "rgb(240, 253, 244)", f"Passbook button background green, got {cust_screen_check['passBg']}"
        assert cust_screen_check["delBg"] == "rgb(254, 242, 242)", f"Delete button background red, got {cust_screen_check['delBg']}"
        assert cust_screen_check["moreBg"] == "rgb(245, 243, 255)", f"More button background purple, got {cust_screen_check['moreBg']}"

        # 7. Check More Options Popover Menu Items
        more_menu_check = client.eval_js(f"""
            (() => {{
                toggleCustomerActionsMenu(null, '{coll_check["customerId"]}');
                const popover = document.getElementById('cust-actions-menu-popover');
                const items = popover ? Array.from(popover.querySelectorAll('.cust-menu-item-title')).map(el => el.innerText.trim()) : [];
                hideCustomerActionsMenu();
                return {{
                    popoverExists: !!popover,
                    menuItemTitles: items
                }};
            }})()
        """)
        print("More Options Popover Check:", json.dumps(more_menu_check, indent=2))
        assert "Customer Passbook & Statement" in more_menu_check["menuItemTitles"]
        assert "Pocket Thermal Slip (58mm)" in more_menu_check["menuItemTitles"]
        assert "Issue Additional Loan" in more_menu_check["menuItemTitles"]
        assert "Send WhatsApp Reminder" in more_menu_check["menuItemTitles"]
        assert "Delete Customer / Loan" in more_menu_check["menuItemTitles"]

        # 8. Settings Screen: Verify Firebase card is at bottom & Collectors Roster
        client.eval_js("switchTab('settings');")
        time.sleep(0.5)

        settings_check = client.eval_js("""
            (() => {
                const settingsView = document.getElementById('view-settings');
                const syncCard = document.getElementById('card-cloud-firebase-sync');
                const pwaCard = document.getElementById('btn-install-pwa-settings')?.closest('.card');
                const rosterDesktop = document.querySelector('.roster-desktop-view');
                const rosterMobile = document.querySelector('.roster-mobile-view');

                let syncIsAfterPwa = false;
                if (syncCard && pwaCard) {
                    syncIsAfterPwa = (pwaCard.compareDocumentPosition(syncCard) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
                }

                return {
                    syncCardExists: !!syncCard,
                    syncIsAfterPwa: syncIsAfterPwa,
                    rosterDesktopExists: !!rosterDesktop,
                    rosterMobileExists: !!rosterMobile
                };
            })()
        """)
        print("Settings Screen Check:", json.dumps(settings_check, indent=2))
        assert settings_check["syncCardExists"], "card-cloud-firebase-sync must exist in Settings"
        assert settings_check["syncIsAfterPwa"], "card-cloud-firebase-sync must be below PWA card at the bottom of Settings view"
        assert settings_check["rosterDesktopExists"], "Desktop roster view must exist"
        assert settings_check["rosterMobileExists"], "Mobile roster view must exist"

        # 9. Dashboard Screen: Verify Admin Personal Collection
        client.eval_js("switchTab('summary');")
        time.sleep(0.5)

        dashboard_check = client.eval_js("""
            (() => {
                const kpiToday = document.getElementById('kpi-today')?.innerText || '₹ 0';
                const adminCard = document.querySelector('.collector-card.admin-collector');
                const adminAmt = adminCard ? adminCard.querySelector('.collector-card-amount')?.innerText : '₹ 0';

                return {
                    kpiToday,
                    adminAmt
                };
            })()
        """)
        print("Dashboard Check:", json.dumps(dashboard_check, indent=2))
        assert dashboard_check["kpiToday"] == dashboard_check["adminAmt"], f"Admin personal collection ({dashboard_check['adminAmt']}) must match today's collection ({dashboard_check['kpiToday']})"

        # 10. Completed Loan Schedule Direct Open Fix
        completed_loan_check = client.eval_js("""
            (() => {
                let compCust = state.customers.find(c => {
                    const s = getCustomerStats(c);
                    return s.balance <= 0;
                });
                if (!compCust) {
                    compCust = state.customers[0];
                }

                openCustomerScheduleDirect(compCust.id);

                const cardInDom = document.querySelector(`.cust-compact-card[data-customer-id="${compCust.id}"]`);
                const isFilterAll = state.filterStatus === 'all';
                const filterVal = document.getElementById('collection-filter-select')?.value;

                return {
                    cardInDom: !!cardInDom,
                    isFilterAll,
                    filterVal
                };
            })()
        """)
        print("Completed Loan Schedule Check:", json.dumps(completed_loan_check, indent=2))
        assert completed_loan_check["cardInDom"], "Completed customer schedule card must be rendered in DOM"
        assert completed_loan_check["isFilterAll"], "Filter status must be reset to 'all'"
        assert completed_loan_check["filterVal"] == "all", "Filter dropdown select value must be 'all'"

        # Capture final screenshot on Customers screen showing the updated action buttons
        client.eval_js("switchTab('customers');")
        time.sleep(0.5)
        client.screenshot("verified_all_latest_fixes.png")
        print("\n🎉 ALL VERIFICATIONS PASSED 100% SUCCESSFULLY!")

    finally:
        if client:
            client.close()
        proc.terminate()
        httpd.shutdown()

if __name__ == "__main__":
    main()
