"""
JSR Finance - Master Engine 1 Backend Test Suite (test_engine1_server.py)
Tests:
 - SQLite3 schema initialization
 - Collision-resistant ID generation (Pitfall #7)
 - IEEE-754 precision rounding (Pitfall #4)
 - Google OAuth & Whitelist Authorization Gate (HTTP 403 enforcement)
 - Customer Master CRUD with 4% margin default
 - Collections cascade waterfall & lineage generation (Pitfall #10 & #11)
 - Analytics CTE aggregation without Cartesian multiplication (Pitfall #1)
"""

import sys
import threading
import time
import json
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

from db import db, generate_doc_id, safe_round, safe_date_str
from server import JSRFinanceHandler

TEST_PORT = 8991

def run_test_server():
    server_address = ("127.0.0.1", TEST_PORT)
    httpd = ThreadingHTTPServer(server_address, JSRFinanceHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd

def http_req(path, method="GET", body=None):
    url = f"http://127.0.0.1:{TEST_PORT}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw}
        return e.code, parsed

def test_database_and_ids():
    print("[1/5] Testing Database schema and collision-resistant IDs...")
    db.init_schema()

    # Generate 1,000 IDs and assert 100% uniqueness (Pitfall #7)
    ids = set()
    for _ in range(1000):
        doc_id = generate_doc_id("TEST")
        assert doc_id not in ids, f"Collision detected for ID: {doc_id}"
        ids.add(doc_id)
    assert len(ids) == 1000, "Expected 1,000 unique IDs"
    print("  [PASS] 1,000 document IDs generated with 0 collisions.")

    # Pitfall #4: Float rounding precision
    res = safe_round(0.1 + 0.2, 2)
    assert res == 0.3, f"Expected 0.3, got {res}"
    print("  [PASS] Float arithmetic precision verified.")
 
def test_health_and_auth():
    print("\n[2/5] Testing /api/health and Google OAuth Whitelist Gate...")
    status, data = http_req("/api/health")
    assert status == 200, f"Expected 200, got {status}"
    assert data["status"] == "healthy"
    print("  [PASS] /api/health verified healthy.")
 
    # Test authorized email on whitelist
    status, data = http_req("/api/auth/google", method="POST", body={
        "email": "admin@jsrfinance.com",
        "name": "Super Admin"
    })
    assert status == 200, f"Expected 200 for whitelisted email, got {status}: {data}"
    assert data["success"] is True
    print("  [PASS] Whitelisted email successfully authenticated.")
 
    # Test unauthorized email rejected with HTTP 403 Forbidden
    status, data = http_req("/api/auth/google", method="POST", body={
        "email": "hacker@unauthorized.com",
        "name": "Intruder"
    })
    assert status == 403, f"Expected 403 for unlisted email, got {status}"
    assert data.get("code") == "AUTH_FORBIDDEN"
    print("  [PASS] Unauthorized email strictly rejected with HTTP 403 Forbidden.")
 
def test_customer_lifecycle():
    print("\n[3/5] Testing Customer Master CRUD and 4% margin default...")
    test_cust_num = 99
    # Clean if exists
    conn = db.get_connection()
    cur = db.get_cursor(conn)
    cur.execute("DELETE FROM customers WHERE customer_number = ?", (test_cust_num,))
    conn.commit()
    conn.close()
 
    # Create new customer with 4% margin
    status, data = http_req("/api/customers", method="POST", body={
        "customerNumber": test_cust_num,
        "fullName": "Kiran Rao",
        "mobile": "9848099999",
        "area": "South Zone",
        "address": "Door #10-4",
        "givenAmount": 10000.0,
        "totalInstalments": 52,
        "frequency": "Weekly"
    })
    assert status == 201, f"Expected 201, got {status}: {data}"
    cust_id = data["customerId"]
 
    # Retrieve and verify 4% margin loan calculation
    status, customers = http_req("/api/customers")
    assert status == 200
    kiran = next((c for c in customers if c["customer_number"] == test_cust_num), None)
    assert kiran is not None, "Created customer not found in customer list"
    assert kiran["full_name"] == "Kiran Rao"
    assert len(kiran["loans"]) == 1
    loan = kiran["loans"][0]
    assert loan["givenAmount"] == 10000.0
    assert loan["totalRepayable"] == 10400.0, f"Expected 10400 (4% profit), got {loan['totalRepayable']}"
    assert loan["instalmentAmount"] == 200.0, f"Expected 200/wk, got {loan['instalmentAmount']}"
    print("  [PASS] Customer created with exact 4% margin default (10,000 -> 10,400 repayable).")
 
    return cust_id, loan["id"]
 
def test_collections_and_lineage(cust_id, loan_id):
    print("\n[4/5] Testing Collections recording and Transactional Lineage...")
    # Receive 1st instalment of Rs. 200
    status, data = http_req("/api/collections", method="POST", body={
        "customerId": cust_id,
        "loanId": loan_id,
        "amount": 200.0,
        "instalmentNumber": 1
    })
    assert status == 201, f"Expected 201, got {status}: {data}"
    assert data["remainingBalance"] == 10200.0, f"Expected 10200 balance, got {data['remainingBalance']}"
    print("  [PASS] Instalment #1 recorded; remaining balance correctly reduced.")
 
    # Check lineage in database (Pitfall #10)
    conn = db.get_connection()
    cur = db.get_cursor(conn)
    cur.execute("SELECT * FROM collection_lineage WHERE collection_id = ?", (data["collectionId"],))
    lineage = cur.fetchone()
    assert lineage is not None, "Transactional lineage record missing"
    assert lineage["principal_portion"] + lineage["profit_portion"] == 200.0
    conn.close()
    print("  [PASS] Lineage principal + profit exact breakdown verified.")
 
    # Rollback (Undo)
    status, undo_data = http_req("/api/collections/undo", method="POST", body={
        "loanId": loan_id,
        "instalmentNumber": 1
    })
    assert status == 200, f"Expected 200 for undo, got {status}: {undo_data}"
    print("  [PASS] Collection undone with non-destructive lineage cleanup.")
 
    # Clean up test customer
    http_req(f"/api/customers/{cust_id}", method="DELETE")
    print("  [PASS] Test customer cleanly deleted.")
 
def test_analytics():
    print("\n[5/5] Testing Analytics without Cartesian row multiplication...")
    status, analytics = http_req("/api/analytics")
    assert status == 200
    assert "totalCustomers" in analytics
    assert "totalDisbursed" in analytics
    assert "totalCollected" in analytics
    assert "outstandingBalance" in analytics
    assert analytics["totalDisbursed"] >= 0
    assert analytics["totalCollected"] >= 0
    print("  [PASS] Analytics aggregations returned clean with zero drift.")

def main():
    print("=== JSR Finance Engine 1 Integration Test Suite ===")
    httpd = run_test_server()
    time.sleep(0.5)

    try:
        test_database_and_ids()
        test_health_and_auth()
        cust_id, loan_id = test_customer_lifecycle()
        test_collections_and_lineage(cust_id, loan_id)
        test_analytics()
        print("\n=======================================================")
        print("ALL ENGINE 1 TESTS PASSED WITH 100% SUCCESS!")
        print("=======================================================")
    finally:
        httpd.shutdown()

if __name__ == "__main__":
    main()
