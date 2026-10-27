import os
import sys
import json
import base64
import urllib.request
import urllib.error

def upload_file_to_github(token, owner, repo, local_path, repo_path, branch="main"):
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{repo_path}"
    
    with open(local_path, "rb") as f:
        content_bytes = f.read()
    
    encoded_content = base64.b64encode(content_bytes).decode("utf-8")
    
    # Check if file exists to get SHA for update (with retries)
    sha = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                f"{url}?ref={branch}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "JSR-Finance-Deployer"
                }
            )
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                sha = data.get("sha")
                if sha:
                    break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            import time; time.sleep(1)
        except Exception as e:
            import time; time.sleep(1)

    payload = {
        "message": f"Deploy {repo_path} - JSR Finance",
        "content": encoded_content,
        "branch": branch
    }
    if sha:
        payload["sha"] = sha

    payload_data = json.dumps(payload).encode("utf-8")
    put_req = urllib.request.Request(
        url,
        data=payload_data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "JSR-Finance-Deployer"
        },
        method="PUT"
    )
    try:
        with urllib.request.urlopen(put_req) as resp:
            print(f"[OK] Uploaded {repo_path} successfully")
            return True
    except urllib.error.HTTPError as e:
        print(f"[FAIL] Failed to upload {repo_path}: {e.code} {e.read().decode('utf-8')}")
        return False

def create_repo_if_needed(token, owner, repo):
    url = "https://api.github.com/user/repos"
    payload = json.dumps({
        "name": repo,
        "description": "JSR Finance - Instalment Receiving System",
        "private": False,
        "auto_init": True
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "JSR-Finance-Deployer"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"[OK] Created repository {owner}/{repo}")
    except urllib.error.HTTPError as e:
        if e.code == 422:
            print(f"Repository {owner}/{repo} already exists, proceeding...")
        else:
            print(f"Repository check response: {e.code}")

def main():
    if len(sys.argv) < 3:
        print("Usage: py push_to_github.py <GITHUB_TOKEN> <GITHUB_OWNER> [REPO_NAME]")
        sys.exit(1)

    token = sys.argv[1].strip()
    owner = sys.argv[2].strip()
    repo = sys.argv[3].strip() if len(sys.argv) > 3 else "jsr-finance"

    create_repo_if_needed(token, owner, repo)

    files_to_upload = [
        ("index.html", "index.html"),
        ("app.js", "app.js"),
        ("styles.css", "styles.css"),
        ("firebase-config.js", "firebase-config.js"),
        ("firebase-sync.js", "firebase-sync.js"),
        ("firebase.json", "firebase.json"),
        ("firestore.rules", "firestore.rules"),
        ("firestore.indexes.json", "firestore.indexes.json"),
        ("login-hero.jpg", "login-hero.jpg"),
        ("README.md", "README.md"),
        (os.path.join(".github", "workflows", "firebase-hosting-merge.yml"), ".github/workflows/firebase-hosting-merge.yml"),
        (os.path.join("docs", "prs", "PR-001.md"), "docs/prs/PR-001.md"),
        (os.path.join("docs", "prs", "PR-002.md"), "docs/prs/PR-002.md"),
        (os.path.join("docs", "prs", "PR-003.md"), "docs/prs/PR-003.md"),
        (os.path.join("docs", "prs", "PR-004.md"), "docs/prs/PR-004.md"),
        (os.path.join("docs", "prs", "PR-005.md"), "docs/prs/PR-005.md"),
        (os.path.join("docs", "prs", "PR-006.md"), "docs/prs/PR-006.md"),
        ("test_pr1_ledger.py", "test_pr1_ledger.py"),
        ("test_suite_all.py", "test_suite_all.py"),
        ("test_six_pro_features.py", "test_six_pro_features.py"),
        ("package_dist.py", "package_dist.py"),
        ("JSR_Finance_Functional_Specification_and_User_Manual.docx", "JSR_Finance_Functional_Specification_and_User_Manual.docx"),
        ("JSR_Finance_Functional_Specification_and_User_Manual.pdf", "JSR_Finance_Functional_Specification_and_User_Manual.pdf"),
        ("server.py", "server.py"),
        ("db.py", "db.py"),
        ("test_engine1_server.py", "test_engine1_server.py"),
        ("test_greenfield_browser.py", "test_greenfield_browser.py"),
        ("test_login_sso_verified.py", "test_login_sso_verified.py"),
        ("test_excel_import.py", "test_excel_import.py"),
        ("test_freeze_verification.py", "test_freeze_verification.py"),
        ("test_instalment_screen_verified.py", "test_instalment_screen_verified.py"),
        ("test_overlap_verification.py", "test_overlap_verification.py"),
        ("test_analytics_makeover_verified.py", "test_analytics_makeover_verified.py"),
        ("test_mobile_fit_and_dates.py", "test_mobile_fit_and_dates.py"),
        ("test_multiuser_concurrency.py", "test_multiuser_concurrency.py"),
        ("test_customer_filters_and_validation.py", "test_customer_filters_and_validation.py"),
        (os.path.join("backend", "src", "schema", "schema.ts"), "backend/src/schema/schema.ts"),
        (os.path.join("backend", "package.json"), "backend/package.json"),
        (os.path.join("frontend", "package.json"), "frontend/package.json")
    ]

    base_dir = os.path.dirname(os.path.abspath(__file__))
    for local_rel, repo_path in files_to_upload:
        local_full = os.path.join(base_dir, local_rel)
        if os.path.exists(local_full):
            upload_file_to_github(token, owner, repo, local_full, repo_path)
        else:
            print(f"Warning: {local_full} not found")

    print("\nAll files successfully pushed to GitHub!")

if __name__ == "__main__":
    main()
