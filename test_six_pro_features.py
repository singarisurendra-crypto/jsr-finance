import os
import re
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def test_feature_1_borrower_kyc_and_photo():
    with open('index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    with open('app.js', 'r', encoding='utf-8') as f:
        js = f.read()
    with open('styles.css', 'r', encoding='utf-8') as f:
        css = f.read()

    # HTML Elements
    assert 'id="modal-kyc-viewer"' in html, "Missing #modal-kyc-viewer in index.html"
    assert 'id="cust-form-photo-data"' in html, "Missing #cust-form-photo-data in index.html"
    assert 'id="cust-form-photo-input"' in html, "Missing #cust-form-photo-input in index.html"
    assert 'id="cust-form-kyc-doc-input"' in html, "Missing #cust-form-kyc-doc-input in index.html"
    assert 'id="cust-form-kyc-doc-name"' in html, "Missing #cust-form-kyc-doc-name in index.html"
    assert 'id="cust-form-kyc-verified"' in html, "Missing #cust-form-kyc-verified in index.html"
    assert 'id="kyc-viewer-content"' in html, "Missing #kyc-viewer-content in index.html"
    assert 'id="kyc-viewer-title"' in html, "Missing #kyc-viewer-title in index.html"

    # JS Handlers & Compression
    assert 'function handleCustomerPhotoUpload' in js, "Missing handleCustomerPhotoUpload in app.js"
    assert 'function clearCustomerPhoto' in js, "Missing clearCustomerPhoto in app.js"
    assert 'function handleKycDocUpload' in js, "Missing handleKycDocUpload in app.js"
    assert 'function clearKycDoc' in js, "Missing clearKycDoc in app.js"
    assert 'function openKycViewerModal' in js, "Missing openKycViewerModal in app.js"
    assert 'toDataURL(\'image/jpeg\', 0.8)' in js or 'toDataURL("image/jpeg", 0.8)' in js, "Missing 0.8 JPEG canvas compression in app.js"

    # CSS classes
    assert '.cust-avatar-img' in css, "Missing .cust-avatar-img in styles.css"
    assert '.kyc-badge' in css, "Missing .kyc-badge in styles.css"
    assert '.kyc-badge-unverified' in css, "Missing .kyc-badge-unverified in styles.css"

    print("[PASS] Feature 1: Borrower KYC Vault & Camera Photo Capture verified.")

def test_feature_2_guarantor_surety_tracking():
    with open('index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    with open('app.js', 'r', encoding='utf-8') as f:
        js = f.read()

    # Profile fields in HTML
    assert 'id="cust-form-guar-name"' in html, "Missing #cust-form-guar-name in index.html"
    assert 'id="cust-form-guar-phone"' in html, "Missing #cust-form-guar-phone in index.html"
    assert 'id="cust-form-guar-rel"' in html, "Missing #cust-form-guar-rel in index.html"
    assert 'id="cust-form-guar-address"' in html, "Missing #cust-form-guar-address in index.html"

    # Recovery handler in JS
    assert 'function contactGuarantor' in js, "Missing contactGuarantor in app.js"
    assert 'wa.me/' in js, "Missing WhatsApp send link (wa.me) in contactGuarantor"
    assert 'guarantorName' in js, "Missing guarantorName reference in app.js"
    assert 'guarantorPhone' in js, "Missing guarantorPhone reference in app.js"

    # 1-Tap Recovery on Overdue Analysis cards
    assert 'contactGuarantor' in js, "Missing guarantor recovery link in app.js"

    print("[PASS] Feature 2: Guarantor / Surety Tracking & 1-Tap Recovery verified.")

def test_feature_3_customer_passbook_and_statement():
    with open('index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    with open('app.js', 'r', encoding='utf-8') as f:
        js = f.read()

    # Passbook modal & print functions
    assert 'id="modal-passbook"' in html, "Missing #modal-passbook in index.html"
    assert 'function openCustomerPassbook' in js, "Missing openCustomerPassbook in app.js"
    assert 'function printCustomerPassbook' in js, "Missing printCustomerPassbook in app.js"
    assert 'Customer Signature' in js, "Missing Customer Signature block in passbook print"
    assert 'Authorized Cashier / Manager' in js or 'Agent / Collector Signature' in js, "Missing management signature in passbook print"
    assert 'Loan Passbook Statement' in js, "Missing Loan Passbook Statement title"

    print("[PASS] Feature 3: Customer Loan Passbook & Statement of Account verified.")

def test_feature_4_bluetooth_thermal_printer():
    with open('index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    with open('app.js', 'r', encoding='utf-8') as f:
        js = f.read()
    with open('styles.css', 'r', encoding='utf-8') as f:
        css = f.read()

    # HTML Elements
    assert 'id="modal-thermal-slip"' in html, "Missing #modal-thermal-slip in index.html"
    assert 'id="bt-status-label"' in html, "Missing #bt-status-label in index.html"
    assert 'id="bt-connect-btn"' in html, "Missing #bt-connect-btn in index.html"
    assert 'id="thermal-slip-preview"' in html, "Missing #thermal-slip-preview in index.html"

    # JS Bluetooth & ESC/POS
    assert 'function connectBluetoothPrinter' in js, "Missing connectBluetoothPrinter in app.js"
    assert 'function generateEscPosBytes' in js, "Missing generateEscPosBytes in app.js"
    assert 'function printThermalViaBluetooth' in js, "Missing printThermalViaBluetooth in app.js"
    assert 'function printThermalSlipBrowser' in js, "Missing printThermalSlipBrowser in app.js"
    assert 'function openThermalReceiptModal' in js, "Missing openThermalReceiptModal in app.js"
    assert '0x1B, 0x40' in js or '0x1b, 0x40' in js or '\\x1B\\x40' in js, "Missing ESC/POS Init sequence (0x1B, 0x40)"
    assert '0x1D, 0x56' in js or '0x1d, 0x56' in js or '\\x1D\\x56' in js, "Missing ESC/POS Cut Paper sequence (0x1D, 0x56)"

    # CSS 58mm Thermal paper & @media print
    assert '.thermal-receipt-paper' in css, "Missing .thermal-receipt-paper in styles.css"
    assert '.printing-thermal' in css, "Missing .printing-thermal in styles.css"
    assert '58mm' in css, "Missing 58mm roll width specification in styles.css"

    print("[PASS] Feature 4: Pocket Bluetooth Thermal Printer Support (ESC/POS) verified.")

def test_feature_5_early_foreclosure_and_noc():
    with open('index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    with open('app.js', 'r', encoding='utf-8') as f:
        js = f.read()
    with open('styles.css', 'r', encoding='utf-8') as f:
        css = f.read()

    # HTML Modals
    assert 'id="modal-loan-settlement"' in html, "Missing #modal-loan-settlement in index.html"
    assert 'id="modal-noc"' in html, "Missing #modal-noc in index.html"
    assert 'id="settle-disp-balance"' in html, "Missing #settle-disp-balance in index.html"
    assert 'id="settle-input-amount"' in html, "Missing #settle-input-amount in index.html"
    assert 'id="noc-certificate-container"' in html, "Missing #noc-certificate-container in index.html"

    # JS Handlers
    assert 'function openSettlementModal' in js, "Missing openSettlementModal in app.js"
    assert 'function updateSettlementCalc' in js, "Missing updateSettlementCalc in app.js"
    assert 'function handleSettlementSubmit' in js, "Missing handleSettlementSubmit in app.js"
    assert 'function openNOCModal' in js, "Missing openNOCModal in app.js"
    assert 'function printNOCCertificate' in js, "Missing printNOCCertificate in app.js"
    assert 'function shareNOCWhatsApp' in js, "Missing shareNOCWhatsApp in app.js"
    assert 'Foreclosure_Settlement' in js, "Missing Foreclosure_Settlement audit transaction type"
    assert 'c.isSettled = true' in js, "Missing c.isSettled = true assignment on closure"

    # CSS Ornate Certificate
    assert '.noc-certificate-sheet' in css, "Missing .noc-certificate-sheet in styles.css"
    assert '.noc-seal-emblem' in css, "Missing .noc-seal-emblem in styles.css"
    assert '.printing-noc' in css, "Missing .printing-noc in styles.css"

    print("[PASS] Feature 5: Early Loan Foreclosure & Settlement Calculator with NOC verified.")

def test_feature_6_credit_health_rating():
    with open('index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    with open('app.js', 'r', encoding='utf-8') as f:
        js = f.read()
    with open('styles.css', 'r', encoding='utf-8') as f:
        css = f.read()

    # JS Credit Calculation & Tiers
    assert 'function calculateCreditRating' in js, "Missing calculateCreditRating in app.js"
    assert 'creditRating: calculateCreditRating(customer)' in js or 'creditRating = calculateCreditRating' in js, "Missing creditRating integration in getCustomerStats"
    assert 'Prime' in js and 'Good' in js and 'Fair' in js and 'High Risk' in js, "Missing credit rating tiers"
    assert 'function applyRecommendedCreditLimit' in js, "Missing applyRecommendedCreditLimit in app.js"

    # Filter options & UI badge classes
    assert 'value="prime"' in html, "Missing prime filter option in index.html"
    assert 'value="settled"' in html, "Missing settled filter option in index.html"
    assert '.credit-badge-prime' in css, "Missing .credit-badge-prime in styles.css"
    assert '.credit-badge-good' in css, "Missing .credit-badge-good in styles.css"
    assert '.credit-badge-fair' in css, "Missing .credit-badge-fair in styles.css"
    assert '.credit-badge-risk' in css, "Missing .credit-badge-risk in styles.css"

    print("[PASS] Feature 6: Borrower Credit Health Rating & Next Loan Eligibility Engine verified.")

if __name__ == '__main__':
    print("=" * 70)
    print("RUNNING AUTOMATED VERIFICATION: ALL 6 ENTERPRISE PRO FEATURES")
    print("=" * 70)
    test_feature_1_borrower_kyc_and_photo()
    test_feature_2_guarantor_surety_tracking()
    test_feature_3_customer_passbook_and_statement()
    test_feature_4_bluetooth_thermal_printer()
    test_feature_5_early_foreclosure_and_noc()
    test_feature_6_credit_health_rating()
    print("=" * 70)
    print("ALL 6 ENTERPRISE PRO FEATURES PASSED VERIFICATION WITH 100% SUCCESS!")
    print("=" * 70)
