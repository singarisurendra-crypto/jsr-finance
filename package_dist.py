import zipfile
import os

def create_dist_zip():
    zip_filename = "JSR_Finance_Package.zip"
    
    files_to_include = [
        "index.html",
        "app.js",
        "styles.css",
        "firebase-config.js",
        "firebase-sync.js",
        "firebase.json",
        "firestore.rules",
        "firestore.indexes.json",
        "login-hero.jpg",
        "README.md",
        "JSR_Finance_Functional_Specification_and_User_Manual.docx",
        "JSR_Finance_Functional_Specification_and_User_Manual.pdf",
        "JSR_Finance_Functional_Specification_and_User_Manual.html",
        "test_pr1_ledger.py",
        "test_suite_all.py",
        "test_six_pro_features.py",
        "test_new_features_suite.py",
        "verify_all_new_features.py",
        os.path.join(".github", "workflows", "firebase-hosting-merge.yml"),
        os.path.join("docs", "prs", "PR-001.md"),
        os.path.join("docs", "prs", "PR-002.md"),
        os.path.join("docs", "prs", "PR-003.md"),
        os.path.join("docs", "prs", "PR-004.md"),
        os.path.join("docs", "prs", "PR-005.md"),
        os.path.join("docs", "prs", "PR-006.md"),
        "server.py",
        "db.py",
        "test_engine1_server.py",
        "test_greenfield_browser.py",
        "test_login_sso_verified.py",
        "test_excel_import.py",
        "test_freeze_verification.py",
        "test_instalment_screen_verified.py",
        "test_overlap_verification.py",
        "test_analytics_makeover_verified.py",
        "test_mobile_fit_and_dates.py",
        "test_multiuser_concurrency.py",
        "test_customer_filters_and_validation.py",
        "verify_analytics_overdue.py",
        os.path.join("backend", "src", "schema", "schema.ts"),
        os.path.join("backend", "package.json"),
        os.path.join("frontend", "package.json")
    ]
    
    print(f"Creating {zip_filename}...")
    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for f in files_to_include:
            if os.path.exists(f):
                zipf.write(f, arcname=f)
                print(f"  + Added: {f}")
            else:
                print(f"  ! Warning: {f} not found")
                
    print(f"[SUCCESS] {zip_filename} rebuilt ({os.path.getsize(zip_filename)} bytes).")

if __name__ == "__main__":
    create_dist_zip()
