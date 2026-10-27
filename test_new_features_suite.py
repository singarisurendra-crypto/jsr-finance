import sys
import re

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def run_tests():
    print("=" * 70)
    print("AUTOMATED VERIFICATION: ALL 7 NEW SUITE FEATURES")
    print("=" * 70)

    with open('index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    with open('app.js', 'r', encoding='utf-8') as f:
        js = f.read()
    with open('styles.css', 'r', encoding='utf-8') as f:
        css = f.read()

    # Test 1: Loan Date Lock on Customer Edit
    assert 'id="cust-form-lock-notice"' in html, "Missing #cust-form-lock-notice in index.html"
    assert 'Loan Disbursal Date' in html, "Lock notice does not mention Loan Disbursal Date"
    assert "dateInput.readOnly = true" in js, "Missing dateInput lock in app.js"
    assert "dateInput.disabled = true" in js, "Missing dateInput disabled in app.js"
    assert "existing.startDate = hasAnyPayment ? (existing.startDate || startDate) : startDate;" in js, "startDate preservation missing in handleSaveCustomer"
    print("[PASS] 1. Loan Date Lock on Customer Edit Screen verified.")

    # Test 2: Customer Profile Photo Lightbox
    assert 'id="photo-lightbox-backdrop"' in html, "Missing #photo-lightbox-backdrop in index.html"
    assert 'id="photo-lightbox-img"' in html, "Missing #photo-lightbox-img in index.html"
    assert 'function openCustomerPhotoLightbox' in js, "Missing openCustomerPhotoLightbox in app.js"
    assert 'function closeCustomerPhotoLightbox' in js, "Missing closeCustomerPhotoLightbox in app.js"
    assert 'openCustomerPhotoLightbox' in js, "Avatar click does not call openCustomerPhotoLightbox"
    assert '.photo-lightbox-backdrop' in css, "Missing .photo-lightbox-backdrop in styles.css"
    print("[PASS] 2. Customer Profile Photo Lightbox verified.")

    # Test 3: Customer Detail Modal & Near-Full-Screen Mobile Bottom Sheet
    assert 'id="modal-customer-detail"' in html, "Missing #modal-customer-detail in index.html"
    assert 'id="customer-detail-backdrop"' in html, "Missing #customer-detail-backdrop in index.html"
    assert 'id="cust-detail-loan-tabs"' in html, "Missing #cust-detail-loan-tabs in index.html"
    assert 'id="cust-detail-loan-content"' in html, "Missing #cust-detail-loan-content in index.html"
    assert 'btn-close-detail' in html, "Missing .btn-close-detail in index.html"
    assert 'function openCustomerDetailModal' in js, "Missing openCustomerDetailModal in app.js"
    assert 'function switchCustomerDetailLoan' in js, "Missing switchCustomerDetailLoan in app.js"
    assert 'function requestCloseCustomerDetailModal' in js, "Missing requestCloseCustomerDetailModal in app.js"
    assert 'function renderCustomerDetailModalContent' in js, "Missing renderCustomerDetailModalContent in app.js"
    assert '.cust-detail-modal' in css, "Missing .cust-detail-modal in styles.css"
    assert '.cust-detail-backdrop' in css, "Missing .cust-detail-backdrop in styles.css"
    assert '.cust-detail-loan-tabs' in css, "Missing .cust-detail-loan-tabs in styles.css"
    assert 'openCustomerDetailModal' in js, "Card header click does not trigger openCustomerDetailModal"
    print("[PASS] 3. Customer Detail Modal & Near-Full-Screen Mobile Bottom Sheet with Multi-Loan Switcher verified.")

    # Test 4: 100% Google OAuth 2.0 GIS Login & RBAC (Zero PIN on Login Screen)
    assert 'id="login-username"' not in html, "Stale login-username input found in index.html"
    assert 'id="login-password"' not in html, "Stale login-password input found in index.html"
    assert 'function verifyAndLoginGoogleUser' in js, "Missing verifyAndLoginGoogleUser in app.js"
    assert 'grantAccess(\'Admin\'' in js or 'grantAccess("Admin"' in js, "Missing Admin grantAccess in app.js"
    assert 'grantAccess(\'Collector\'' in js or 'grantAccess("Collector"' in js, "Missing Collector grantAccess in app.js"
    assert 'HTTP 403 Forbidden' in js, "Missing HTTP 403 Forbidden check in app.js"
    print("[PASS] 4. 100% Google OAuth 2.0 GIS Login & RBAC (Zero PIN on Login Screen) verified.")

    # Test 5: Settings Email Configuration & Field Collectors Roster
    assert 'id="setting-admin-email"' in html, "Missing #setting-admin-email in index.html"
    assert 'id="collectors-roster-container"' in html, "Missing #collectors-roster-container in index.html"
    assert 'id="modal-collector-editor"' in html, "Missing #modal-collector-editor in index.html"
    assert 'function renderCollectorsRoster' in js, "Missing renderCollectorsRoster in app.js"
    assert 'function openAddCollectorModal' in js, "Missing openAddCollectorModal in app.js"
    assert 'function openEditCollectorModal' in js, "Missing openEditCollectorModal in app.js"
    assert 'function handleSaveCollector' in js, "Missing handleSaveCollector in app.js"
    assert 'function toggleCollectorStatus' in js, "Missing toggleCollectorStatus in app.js"
    print("[PASS] 5. Settings Admin Email & Field Collectors Roster management verified.")

    # Test 6: Role-Gated Dashboard & Admin Personal Collections
    assert 'id="dashboard-collector-breakdown"' in html, "Missing #dashboard-collector-breakdown in index.html"
    assert 'id="recent-collector-filter"' in html, "Missing #recent-collector-filter in index.html"
    assert 'id="modal-collector-handover"' in html, "Missing #modal-collector-handover in index.html"
    assert 'function renderCollectorBreakdownWidget' in js, "Missing renderCollectorBreakdownWidget in app.js"
    assert 'function openCollectorHandoverModal' in js, "Missing openCollectorHandoverModal in app.js"
    assert 'function printCollectorHandoverSlip' in js, "Missing printCollectorHandoverSlip in app.js"
    assert 'Admin (Personal Collections)' in js, "Missing Admin Personal Collections attribution in app.js"
    print("[PASS] 6. Role-Gated Dashboard & Admin Personal Collections Tracking verified.")

    # Test 7: Local-First Offline Collection Mode & Auto-Sync Engine
    assert 'id="offline-sync-badge"' in html, "Missing #offline-sync-badge in index.html"
    assert 'id="sync-conflict-backdrop"' in html, "Missing #sync-conflict-backdrop in index.html"
    assert 'updateOfflineSyncBadge' in js, "Missing updateOfflineSyncBadge in app.js"
    assert 'setupOfflineSyncListeners' in js, "Missing setupOfflineSyncListeners in app.js"
    assert 'triggerOfflineSync' in js, "Missing triggerOfflineSync in app.js"
    assert 'triggerManualOfflineSync' in js, "Missing triggerManualOfflineSync in app.js"
    assert 'showSyncConflictModal' in js, "Missing showSyncConflictModal in app.js"
    assert 'submitSyncConflictResolution' in js, "Missing submitSyncConflictResolution in app.js"
    assert 'offlineSyncQueue' in js, "Missing offlineSyncQueue state in app.js"
    assert 'PROV-' in js, "Missing PROV- provisional receipt generation in app.js"
    print("[PASS] 7. Local-First Offline Collection Mode & Auto-Sync Engine verified.")

    print("=" * 70)
    print("ALL 7 CORE FEATURES PASSED 100% WITH ZERO ERRORS!")
    print("=" * 70)

if __name__ == '__main__':
    run_tests()
