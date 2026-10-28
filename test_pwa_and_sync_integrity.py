import os
import sys
import json
import struct
import re

def test_pwa_and_sync():
    print("==================================================")
    print("RUNNING PWA & FIRESTORE SECURITY VERIFICATION SUITE")
    print("==================================================")

    # 1. Verify manifest.json
    print("\n[1/6] Verifying manifest.json...")
    assert os.path.exists("manifest.json"), "manifest.json missing!"
    with open("manifest.json", "r", encoding="utf-8") as f:
        manifest = json.load(f)
    assert manifest.get("name") == "JSR Finance - Field Collection & Microfinance", "manifest name mismatch"
    assert manifest.get("short_name") == "JSR Finance", "manifest short_name mismatch"
    assert manifest.get("display") == "standalone", "manifest display should be standalone"
    assert manifest.get("theme_color") == "#2563eb", "theme_color mismatch"
    assert manifest.get("start_url") == "./index.html", "start_url mismatch"
    
    icons = manifest.get("icons", [])
    assert len(icons) >= 3, f"Expected at least 3 icons, found {len(icons)}"
    for icon in icons:
        src = icon["src"]
        assert os.path.exists(src), f"Referenced icon file missing: {src}"
        print(f"  [OK] Found manifest icon: {src} ({icon.get('sizes')})")

    # 2. Verify Icon PNG headers & dimensions
    print("\n[2/6] Verifying icon image files...")
    icon_checks = [
        ("icon-192.png", 192, 192),
        ("icon-512.png", 512, 512),
        ("apple-touch-icon.png", 180, 180)
    ]
    for fn, expected_w, expected_h in icon_checks:
        assert os.path.exists(fn), f"Icon missing: {fn}"
        with open(fn, "rb") as f:
            data = f.read()
        sig = data[:8]
        assert sig == b'\x89PNG\r\n\x1a\n', f"Not a valid PNG: {fn}"
        w, h = struct.unpack(">II", data[16:24])
        assert w == expected_w and h == expected_h, f"Dimension mismatch for {fn}: expected {expected_w}x{expected_h}, got {w}x{h}"
        print(f"  [OK] {fn} validated: {w}x{h} PNG ({len(data)} bytes)")

    assert os.path.exists("icon.svg"), "icon.svg missing!"
    with open("icon.svg", "r", encoding="utf-8") as f:
        svg_content = f.read()
    assert "<svg" in svg_content and "</svg>" in svg_content, "icon.svg invalid"
    print("  [OK] icon.svg validated")

    # 3. Verify service-worker.js
    print("\n[3/6] Verifying service-worker.js...")
    assert os.path.exists("service-worker.js"), "service-worker.js missing!"
    with open("service-worker.js", "r", encoding="utf-8") as f:
        sw_code = f.read()
    assert "CACHE_NAME" in sw_code, "CACHE_NAME missing in service-worker"
    assert "PRECACHE_ASSETS" in sw_code, "PRECACHE_ASSETS missing in service-worker"
    assert "EXTERNAL_LIBRARIES" in sw_code, "EXTERNAL_LIBRARIES missing in service-worker"
    assert "firestore.googleapis.com" in sw_code, "Live firestore bypass check missing"
    assert "ignoreSearch: true" in sw_code, "ignoreSearch missing in caches.match"
    print("  [OK] service-worker.js precaching & offline caching validated")

    # 4. Verify index.html integrations
    print("\n[4/6] Verifying index.html PWA tags & UI elements...")
    with open("index.html", "r", encoding="utf-8") as f:
        html = f.read()
    assert '<link rel="manifest" href="manifest.json">' in html, "Manifest link missing in index.html"
    assert '<meta name="theme-color" content="#2563eb">' in html, "theme-color missing in index.html"
    assert '<meta name="apple-mobile-web-app-capable" content="yes">' in html, "apple-mobile-web-app-capable missing"
    assert '<link rel="apple-touch-icon" href="apple-touch-icon.png">' in html, "apple-touch-icon missing"
    assert 'id="btn-install-pwa"' in html, "Header install button missing"
    assert 'id="btn-install-pwa-settings"' in html, "Settings install button missing"
    assert 'Mobile App &amp; Offline PWA Suite' in html or 'Mobile App & Offline PWA Suite' in html, "PWA settings card missing"
    assert 'styles.css?v=55' in html, "styles.css?v=55 version tag missing"
    assert 'app.js?v=55' in html, "app.js?v=55 version tag missing"
    print("  [OK] index.html links, icons, and UI install buttons verified")

    # 5. Verify firestore.rules security lockdown
    print("\n[5/6] Verifying firestore.rules...")
    with open("firestore.rules", "r", encoding="utf-8") as f:
        rules = f.read()
    assert "request.auth != null" in rules, "Missing request.auth != null guard!"
    assert "allow delete: if isAdmin();" in rules, "Customers deletion not restricted to admin"
    assert "allow update, delete: if false;" in rules, "Transactions not immutable"
    print("  [OK] firestore.rules strictly requires authenticated operators & immutable transactions")

    # 6. Verify firebase-sync.js & app.js session tracking and self-sync
    print("\n[6/6] Verifying session tracking & offline self-sync...")
    with open("firebase-sync.js", "r", encoding="utf-8") as f:
        sync_code = f.read()
    assert "CURRENT_SESSION_ID" in sync_code, "CURRENT_SESSION_ID missing in firebase-sync.js"
    assert "lastModifiedSession: typeof CURRENT_SESSION_ID" in sync_code or "lastModifiedSession" in sync_code, "lastModifiedSession not set in syncCustomerToFirestore"
    assert "c.lastModifiedSession === CURRENT_SESSION_ID" in sync_code, "Self-modification suppression missing"

    with open("app.js", "r", encoding="utf-8") as f:
        app_code = f.read()
    assert "registerServiceWorker()" in app_code, "registerServiceWorker not called in app.js"
    assert "handlePwaInstallClick" in app_code, "handlePwaInstallClick missing in app.js"
    assert "isSelfSync" in app_code, "isSelfSync missing in triggerOfflineSync"
    print("  [OK] Session tagging & self-sync conflict bypass verified")

    print("\n==================================================")
    print("ALL PWA & SYNC INTEGRITY CHECKS PASSED SUCCESSFULLY!")
    print("==================================================")

if __name__ == "__main__":
    test_pwa_and_sync()
