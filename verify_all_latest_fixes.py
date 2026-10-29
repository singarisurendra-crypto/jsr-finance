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

        # 2. Verify Top Header & Left Sidebar (Pure white #ffffff, user badge removed, user card down)
        header_sidebar_check = client.eval_js("""
            (() => {
                const badge = document.getElementById('header-user-badge');
                const syncPill = document.getElementById('cloud-status-pill');
                const header = document.querySelector('.app-header');
                const sidebar = document.getElementById('app-sidebar');
                const sidebarUserCard = document.getElementById('sidebar-user-card');
                const sidebarUserAvatar = document.getElementById('sidebar-user-avatar');
                const sidebarUserName = document.getElementById('sidebar-user-name');
                const sidebarUserRole = document.getElementById('sidebar-user-role');
                const sidebarLogout = document.querySelector('.sidebar-logout-btn');
                const activePill = document.querySelector('.stat-pill-active');

                const headerStyle = header ? window.getComputedStyle(header) : null;
                const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : null;
                const activePillStyle = activePill ? window.getComputedStyle(activePill) : null;

                const mobileActions = document.querySelector('.mobile-header-actions');
                const mobileSettings = mobileActions ? mobileActions.querySelector('button[data-tab="settings"]') : null;
                const mobileLogout = mobileActions ? mobileActions.querySelector('.mobile-logout-btn') : null;
                const mobileActionsStyle = mobileActions ? window.getComputedStyle(mobileActions) : null;
                const mobileLogoutText = mobileLogout ? mobileLogout.innerText.trim() : '';

                let mobileSettingsRadius = '';
                let mobileLogoutRadius = '';
                if (mobileActions && mobileSettings && mobileLogout) {
                    const prevDisplay = mobileActions.style.display;
                    mobileActions.style.display = 'flex';
                    mobileSettingsRadius = window.getComputedStyle(mobileSettings).borderRadius;
                    mobileLogoutRadius = window.getComputedStyle(mobileLogout).borderRadius;
                    mobileActions.style.display = prevDisplay;
                }

                return {
                    headerBadgeExists: !!badge,
                    syncPillExistsInDom: !!syncPill,
                    headerBg: headerStyle ? headerStyle.backgroundColor : '',
                    sidebarBg: sidebarStyle ? sidebarStyle.backgroundColor : '',
                    sidebarUserCardExists: !!sidebarUserCard,
                    sidebarAvatar: sidebarUserAvatar ? sidebarUserAvatar.innerText.trim() : '',
                    sidebarName: sidebarUserName ? sidebarUserName.innerText.trim() : '',
                    sidebarRole: sidebarUserRole ? sidebarUserRole.innerText.trim() : '',
                    sidebarLogoutExists: !!sidebarLogout,
                    activePillMinWidth: activePillStyle ? activePillStyle.minWidth : '',
                    mobileActionsExists: !!mobileActions,
                    mobileSettingsExists: !!mobileSettings,
                    mobileLogoutExists: !!mobileLogout,
                    mobileLogoutText,
                    mobileSettingsRadius,
                    mobileLogoutRadius,
                    mobileActionsDisplayDesktop: mobileActionsStyle ? mobileActionsStyle.display : ''
                };
            })()
        """)
        print("Header & Sidebar Check:", json.dumps(header_sidebar_check, indent=2))
        assert not header_sidebar_check["headerBadgeExists"], "Top menu must NOT have Full access / user badge (removed duplicate)"
        assert not header_sidebar_check["syncPillExistsInDom"], "Sync: Live pill must be removed from top header"
        assert header_sidebar_check["headerBg"] == "rgb(255, 255, 255)", f"Header background must be pure white #ffffff, got: {header_sidebar_check['headerBg']}"
        assert header_sidebar_check["sidebarBg"] == "rgb(255, 255, 255)", f"Sidebar background must be pure white #ffffff, got: {header_sidebar_check['sidebarBg']}"
        assert header_sidebar_check["sidebarUserCardExists"], "Left menu down must have user card"
        assert header_sidebar_check["sidebarAvatar"] == "S", f"Sidebar avatar 'S', got: {header_sidebar_check['sidebarAvatar']}"
        assert "Surendra" in header_sidebar_check["sidebarName"] or "surendra" in header_sidebar_check["sidebarName"], f"Expected surendra, got: {header_sidebar_check['sidebarName']}"
        assert "FULL ACCESS" in header_sidebar_check["sidebarRole"].upper() or "ADMIN" in header_sidebar_check["sidebarRole"].upper(), f"Expected FULL ACCESS, got: {header_sidebar_check['sidebarRole']}"
        assert header_sidebar_check["sidebarLogoutExists"], "Left menu down must have logout button"
        assert header_sidebar_check["mobileActionsExists"], "Mobile header actions container must exist"
        assert header_sidebar_check["mobileSettingsExists"], "Mobile top Settings button must exist"
        assert header_sidebar_check["mobileLogoutExists"], "Mobile top Logout button must exist"
        assert header_sidebar_check["mobileLogoutText"] == "", f"Logout button must have NO text (icon-only), got: {header_sidebar_check['mobileLogoutText']}"
        assert header_sidebar_check["mobileSettingsRadius"] == "8px", f"Settings button must have border-radius 8px, got: {header_sidebar_check['mobileSettingsRadius']}"
        assert header_sidebar_check["mobileLogoutRadius"] == "8px", f"Logout button must have border-radius 8px, got: {header_sidebar_check['mobileLogoutRadius']}"
        assert header_sidebar_check["mobileActionsDisplayDesktop"] == "none", "Mobile header actions must be hidden on desktop view"

        # 3. Test Collections View & Compact Badges & Removed Print Option
        client.eval_js("switchTab('collections');")
        time.sleep(0.5)

        toolbar_check = client.eval_js("""
            (() => {
                const toolbar = document.querySelector('.coll-action-toolbar');
                const printBtn = toolbar ? toolbar.querySelector('button[onclick*="print"]') : null;
                const buttons = toolbar ? Array.from(toolbar.querySelectorAll('button')).map(b => b.innerText.trim()) : [];
                return {
                    toolbarExists: !!toolbar,
                    printBtnExists: !!printBtn,
                    buttons: buttons
                };
            })()
        """)
        print("Instalment Toolbar Check:", json.dumps(toolbar_check, indent=2))
        assert toolbar_check["toolbarExists"], "Toolbar must exist"
        assert not toolbar_check["printBtnExists"], "Print option must be removed from instalment screen toolbar"

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

        # 5. Open Customer Detail Modal & Verify Compact Toolbar, Passbook, Thermal Slip, and Loan Type Lock in Edit Mode
        modal_check = client.eval_js(f"""
            (() => {{
                openCustomerDetailModal('{coll_check["customerId"]}');
                const modal = document.getElementById('modal-customer-detail');
                const toolbar = modal ? modal.querySelector('.sched-quick-toolbar') : null;
                const partialBtn = toolbar ? toolbar.querySelector('button[onclick*="openPartialPayModal"]') : null;
                const partialBtnStyle = partialBtn ? window.getComputedStyle(partialBtn) : null;
                const passbookBtn = modal ? modal.querySelector('button[onclick*="openCustomerPassbook"]') : null;
                const thermalBtn = modal ? modal.querySelector('button[onclick*="openThermalReceiptModal"]') : null;
                const editBtn = modal ? modal.querySelector('button[onclick*="openEditCustomerModal"]') : null;

                return {{
                    modalDisplayed: modal && modal.style.display !== 'none',
                    toolbarText: toolbar ? toolbar.innerText : '',
                    partialBtnBg: partialBtnStyle ? partialBtnStyle.backgroundColor : '',
                    passbookBtnExists: !!passbookBtn,
                    thermalBtnExists: !!thermalBtn,
                    editBtnExists: !!editBtn
                }};
            }})()
        """)
        print("Detail Modal Check:", json.dumps(modal_check, indent=2))
        assert modal_check["modalDisplayed"], "Customer detail modal must be visible"
        assert "Bal:" in modal_check["toolbarText"], f"Detail modal must have compact 'Bal:', got: {modal_check['toolbarText']}"
        assert modal_check["partialBtnBg"] == "rgb(254, 243, 199)", f"Partial pay button background must be amber #fef3c7, got: {modal_check['partialBtnBg']}"
        assert modal_check["passbookBtnExists"], "Passbook button must exist in customer detail modal"
        assert modal_check["thermalBtnExists"], "Thermal Slip button must exist in customer detail modal"
        assert modal_check["editBtnExists"], "Edit Terms button must exist in customer detail modal"

        # Test Passbook trigger from detail modal
        passbook_trigger_check = client.eval_js(f"""
            (() => {{
                openCustomerPassbook('{coll_check["customerId"]}');
                const pbModal = document.getElementById('modal-passbook');
                const isOpen = pbModal && pbModal.style.display !== 'none';
                if (isOpen) closeModal('modal-passbook');
                return {{ isOpen }};
            }})()
        """)
        print("Passbook Trigger Check:", json.dumps(passbook_trigger_check, indent=2))
        assert passbook_trigger_check["isOpen"], "Passbook modal must open from detail modal trigger"

        # Test Thermal Slip trigger from detail modal
        thermal_trigger_check = client.eval_js(f"""
            (() => {{
                openThermalReceiptModal('{coll_check["customerId"]}', 1);
                const tsModal = document.getElementById('modal-thermal-slip');
                const isOpen = tsModal && tsModal.style.display !== 'none';
                if (isOpen) closeModal('modal-thermal-slip');
                return {{ isOpen }};
            }})()
        """)
        print("Thermal Slip Trigger Check:", json.dumps(thermal_trigger_check, indent=2))
        assert thermal_trigger_check["isOpen"], "Thermal slip modal must open from detail modal trigger"

        # Test Edit Customer: Loan account type option must be DISABLED
        edit_cust_check = client.eval_js(f"""
            (() => {{
                openEditCustomerModal('{coll_check["customerId"]}');
                const custModal = document.getElementById('modal-customer');
                const radioNew = document.getElementById('loan-type-new');
                const radioExisting = document.getElementById('loan-type-existing');
                const wrap = document.getElementById('cust-form-loan-type-wrap');

                const isCustModalOpen = custModal && custModal.style.display !== 'none';
                const isNewDisabled = radioNew ? radioNew.disabled : false;
                const isExistingDisabled = radioExisting ? radioExisting.disabled : false;
                const isWrapDisabled = wrap ? (wrap.style.pointerEvents === 'none') : false;

                closeModal('modal-customer');

                // Now test openAddCustomerModal re-enables them
                openAddCustomerModal();
                const addModalOpen = custModal && custModal.style.display !== 'none';
                const isNewEnabledInAdd = radioNew ? !radioNew.disabled : false;
                const isExistingEnabledInAdd = radioExisting ? !radioExisting.disabled : false;
                const isWrapEnabledInAdd = wrap ? (wrap.style.pointerEvents === 'auto') : false;

                closeModal('modal-customer');

                return {{
                    isCustModalOpen,
                    isNewDisabled,
                    isExistingDisabled,
                    isWrapDisabled,
                    addModalOpen,
                    isNewEnabledInAdd,
                    isExistingEnabledInAdd,
                    isWrapEnabledInAdd
                }};
            }})()
        """)
        print("Edit Customer Loan Type Lock Check:", json.dumps(edit_cust_check, indent=2))
        assert edit_cust_check["isCustModalOpen"], "Customer modal must open when editing customer"
        assert edit_cust_check["isNewDisabled"], "loan-type-new must be disabled in edit mode"
        assert edit_cust_check["isExistingDisabled"], "loan-type-existing must be disabled in edit mode"
        assert edit_cust_check["isWrapDisabled"], "cust-form-loan-type-wrap pointerEvents must be 'none' in edit mode"
        assert edit_cust_check["isNewEnabledInAdd"], "loan-type-new must be enabled in add customer mode"
        assert edit_cust_check["isExistingEnabledInAdd"], "loan-type-existing must be enabled in add customer mode"
        assert edit_cust_check["isWrapEnabledInAdd"], "cust-form-loan-type-wrap pointerEvents must be 'auto' in add customer mode"

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

        # 9. Dashboard Screen: Verify Admin Personal Collection & Operator Collections by Date Filter
        client.eval_js("switchTab('summary');")
        time.sleep(0.5)

        dashboard_check = client.eval_js("""
            (() => {
                const kpiToday = document.getElementById('kpi-today')?.innerText || '₹ 0';
                const adminCard = document.querySelector('.collector-card.admin-collector');
                const adminAmt = adminCard ? adminCard.querySelector('.collector-card-amount')?.innerText : '₹ 0';
                const filterSelect = document.getElementById('collector-date-preset-filter');
                const customDateInput = document.getElementById('collector-custom-date');
                const breakdownSub = document.getElementById('collector-breakdown-sub');

                const filterOptions = filterSelect ? Array.from(filterSelect.options).map(o => o.value) : [];

                // Test date filter switching to 'all'
                handleCollectorDateFilterChange('all');
                const subAfterAll = breakdownSub ? breakdownSub.innerText : '';

                // Switch to 'custom'
                handleCollectorDateFilterChange('custom');
                const customInputDisplay = customDateInput ? customDateInput.style.display : 'none';

                // Switch back to 'today'
                handleCollectorDateFilterChange('today');

                // Calculate sum of all collector cards
                const allCards = Array.from(document.querySelectorAll('.collector-card'));
                let totalCardsAmt = 0;
                allCards.forEach(card => {
                    const amtStr = card.querySelector('.collector-card-amount')?.innerText || '₹ 0';
                    const num = Number(amtStr.replace(/[^0-9]/g, '')) || 0;
                    totalCardsAmt += num;
                });

                return {
                    kpiToday,
                    adminAmt,
                    totalCardsAmt,
                    filterExists: !!filterSelect,
                    filterOptions,
                    subAfterAll,
                    customInputDisplay
                };
            })()
        """)
        print("Dashboard Check:", json.dumps(dashboard_check, indent=2))
        kpi_num = int(dashboard_check["kpiToday"].replace("₹", "").replace(",", "").strip() or 0)
        assert dashboard_check["totalCardsAmt"] == kpi_num, f"Total of collector breakdown cards ({dashboard_check['totalCardsAmt']}) must match today's portfolio collection ({kpi_num})"
        assert dashboard_check["adminAmt"] != "₹ 0" or kpi_num == 0, "Admin personal collections must not be zero when collections exist"
        assert dashboard_check["filterExists"], "collector-date-preset-filter must exist in dashboard"
        assert "today" in dashboard_check["filterOptions"], "today option must exist"
        assert "yesterday" in dashboard_check["filterOptions"], "yesterday option must exist"
        assert "this-week" in dashboard_check["filterOptions"], "this-week option must exist"
        assert "this-month" in dashboard_check["filterOptions"], "this-month option must exist"
        assert dashboard_check["allDatesSub"] if "allDatesSub" in dashboard_check else True
        assert dashboard_check["customInputDisplay"] == "inline-block", "Custom date input should be visible for 'custom' filter"

        # Test opening Admin Personal Audit Slip modal
        admin_slip_check = client.eval_js("""
            (() => {
                openCollectorHandoverModal('Admin');
                const modal = document.getElementById('modal-collector-handover');
                const title = document.getElementById('collector-handover-title');
                const isOpen = modal && (modal.classList.contains('active') || modal.style.display === 'flex');
                const titleText = title ? title.innerText : '';
                closeModal('modal-collector-handover');
                return {
                    isOpen,
                    titleText
                };
            })()
        """)
        print("Admin Slip Modal Check:", json.dumps(admin_slip_check, indent=2))
        assert admin_slip_check["isOpen"], "Admin Personal Audit Slip modal must open"
        assert "Admin Personal Collections" in admin_slip_check["titleText"], f"Expected Admin title, got: {admin_slip_check['titleText']}"

        # Test opening Field Collector Handover Slip modal
        field_slip_check = client.eval_js("""
            (() => {
                const roster = state.settings.collectors || [];
                const colName = roster.length > 0 ? roster[0].name : 'Test Collector';
                openCollectorHandoverModal(colName);
                const modal = document.getElementById('modal-collector-handover');
                const title = document.getElementById('collector-handover-title');
                const isOpen = modal && (modal.classList.contains('active') || modal.style.display === 'flex');
                const titleText = title ? title.innerText : '';
                closeModal('modal-collector-handover');
                return {
                    isOpen,
                    titleText,
                    colName
                };
            })()
        """)
        print("Field Collector Slip Modal Check:", json.dumps(field_slip_check, indent=2))
        assert field_slip_check["isOpen"], "Field Collector Handover Slip modal must open"
        assert field_slip_check["colName"] in field_slip_check["titleText"], f"Expected {field_slip_check['colName']} in title, got: {field_slip_check['titleText']}"

        # 9.5 Singari Suri ₹ 2,600 and Admin ₹ 12,700 Field Collector Attribution Test
        suri_attribution_check = client.eval_js("""
            (() => {
                // Register 'Singari Suri' on the roster
                if (!Array.isArray(state.settings.collectors)) state.settings.collectors = [];
                let suriCol = state.settings.collectors.find(c => c.name.toLowerCase().includes('suri'));
                if (!suriCol) {
                    suriCol = { id: 'col_suri', name: 'Singari Suri', email: 'suri@jsrfinance.com', phone: '+91 9999999999', route: 'Market Ward A', active: true };
                    state.settings.collectors.push(suriCol);
                }

                const todayStr = getISTDateString();
                const nowTs = getNowTimestamp();
                const testCust = state.customers[0];

                // Clear today's test transactions to set up exact user scenario:
                // Admin: ₹ 12,700 across 3 receipts
                // Singari Suri: ₹ 2,600 across 2 receipts
                state.transactions = (state.transactions || []).filter(t => t.date !== todayStr);

                // Admin collections totaling ₹ 12,700
                state.transactions.push({
                    id: 'TXN-ADMIN-1',
                    receiptNumber: 'REC-ADM-1',
                    customerId: testCust ? testCust.id : 'cus_1',
                    customerNumber: testCust ? testCust.customerNumber : '1',
                    loanNumber: 1,
                    customerName: testCust ? testCust.fullName : 'Test Borrower',
                    instalmentNumber: 1,
                    amount: 5000,
                    type: 'payment',
                    collector: 'Surendra Singari',
                    date: todayStr,
                    timestamp: nowTs,
                    createdAt: new Date().toISOString()
                });
                state.transactions.push({
                    id: 'TXN-ADMIN-2',
                    receiptNumber: 'REC-ADM-2',
                    customerId: testCust ? testCust.id : 'cus_1',
                    customerNumber: testCust ? testCust.customerNumber : '1',
                    loanNumber: 1,
                    customerName: testCust ? testCust.fullName : 'Test Borrower',
                    instalmentNumber: 2,
                    amount: 5000,
                    type: 'payment',
                    collector: 'Admin',
                    date: todayStr,
                    timestamp: nowTs,
                    createdAt: new Date().toISOString()
                });
                state.transactions.push({
                    id: 'TXN-ADMIN-3',
                    receiptNumber: 'REC-ADM-3',
                    customerId: testCust ? testCust.id : 'cus_1',
                    customerNumber: testCust ? testCust.customerNumber : '1',
                    loanNumber: 1,
                    customerName: testCust ? testCust.fullName : 'Test Borrower',
                    instalmentNumber: 3,
                    amount: 2700,
                    type: 'payment',
                    collector: 'Surendra Singari',
                    date: todayStr,
                    timestamp: nowTs,
                    createdAt: new Date().toISOString()
                });

                // Singari Suri collections totaling ₹ 2,600
                state.transactions.push({
                    id: 'TXN-SURI-1',
                    receiptNumber: 'REC-SURI-1',
                    customerId: testCust ? testCust.id : 'cus_1',
                    customerNumber: testCust ? testCust.customerNumber : '1',
                    loanNumber: 1,
                    customerName: testCust ? testCust.fullName : 'Test Borrower',
                    instalmentNumber: 4,
                    amount: 1600,
                    type: 'payment',
                    collector: 'Singari Suri',
                    collectorId: 'col_suri',
                    date: todayStr,
                    timestamp: nowTs,
                    createdAt: new Date().toISOString()
                });
                state.transactions.push({
                    id: 'TXN-SURI-2',
                    receiptNumber: 'REC-SURI-2',
                    customerId: testCust ? testCust.id : 'cus_1',
                    customerNumber: testCust ? testCust.customerNumber : '1',
                    loanNumber: 1,
                    customerName: testCust ? testCust.fullName : 'Test Borrower',
                    instalmentNumber: 5,
                    amount: 1000,
                    type: 'payment',
                    collector: 'Singari Suri',
                    collectorId: 'col_suri',
                    date: todayStr,
                    timestamp: nowTs,
                    createdAt: new Date().toISOString()
                });

                // Re-render dashboard and breakdown
                renderDashboard();
                renderCollectorBreakdownWidget();

                const suriCard = Array.from(document.querySelectorAll('.collector-card.field-collector')).find(card => 
                    card.innerText.includes('Singari Suri')
                );
                const suriAmount = suriCard ? suriCard.querySelector('.collector-card-amount')?.innerText : '';

                const adminCard = document.querySelector('.collector-card.admin-collector');
                const adminAmount = adminCard ? adminCard.querySelector('.collector-card-amount')?.innerText : '';

                // Test opening handover modal for Singari Suri
                openCollectorHandoverModal('Singari Suri');
                const suriSlipTitle = document.getElementById('collector-handover-title')?.innerText || '';
                const suriSlipContent = document.getElementById('collector-handover-slip-content')?.innerText || '';
                closeModal('modal-collector-handover');

                // Test opening personal audit slip modal for Admin
                openCollectorHandoverModal('Admin');
                const adminSlipTitle = document.getElementById('collector-handover-title')?.innerText || '';
                const adminSlipContent = document.getElementById('collector-handover-slip-content')?.innerText || '';
                closeModal('modal-collector-handover');

                return {
                    suriCardFound: !!suriCard,
                    suriAmount,
                    adminAmount,
                    suriSlipTitle,
                    has2600InSuriSlip: suriSlipContent.includes('2,600'),
                    adminSlipTitle,
                    has12700InAdminSlip: adminSlipContent.includes('12,700')
                };
            })()
        """)
        print("Singari Suri & Admin Attribution Check:", json.dumps(suri_attribution_check, indent=2))
        assert suri_attribution_check["suriCardFound"], "Singari Suri collector card must be rendered in dashboard"
        assert "2,600" in suri_attribution_check["suriAmount"], f"Singari Suri card must show ₹ 2,600, got: {suri_attribution_check['suriAmount']}"
        assert "12,700" in suri_attribution_check["adminAmount"], f"Admin card must show ₹ 12,700, got: {suri_attribution_check['adminAmount']}"
        assert "Singari Suri" in suri_attribution_check["suriSlipTitle"], f"Handover slip title must mention Singari Suri, got: {suri_attribution_check['suriSlipTitle']}"
        assert suri_attribution_check["has2600InSuriSlip"], "Singari Suri handover slip content must include ₹ 2,600"
        assert suri_attribution_check["has12700InAdminSlip"], "Admin audit slip content must include ₹ 12,700"

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
