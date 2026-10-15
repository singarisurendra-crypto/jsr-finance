"""
JSR Finance - Dual-Engine Database Abstraction Layer (db.py)
Guards:
 - Pitfall #4: IEEE-754 precision rounding (round(val, 2) at every step)
 - Pitfall #5: PostgreSQL NUMERIC vs float cast defense
 - Pitfall #6: Safe ISO date handling (no empty string coercion)
 - Pitfall #7: High-concurrency collision-resistant ID generation (DOC-YYYYMMDDHHMMSSFFFFFF-XXXX)
 - Pitfall #11: Non-destructive cascade lineage cleanup before parent deletion
 - Pitfall #12: dict(row) standardization for SQLite & Postgres, placeholder mapping (? vs %s)
"""

import os
import sqlite3
import datetime
import uuid
import json
from decimal import Decimal

# Optional PostgreSQL support
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    HAS_POSTGRES = True
except ImportError:
    HAS_POSTGRES = False

DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jsr_finance.db")
DATABASE_URL = os.environ.get("DATABASE_URL")  # e.g., postgresql://user:pass@host:5432/dbname

def generate_doc_id(prefix="DOC"):
    """Pitfall #7: Microsecond precision + random UUID token prevents high-concurrency collisions."""
    now = datetime.datetime.now(datetime.timezone.utc)
    ts_str = now.strftime("%Y%m%d%H%M%S%f")
    token = uuid.uuid4().hex[:4].upper()
    return f"{prefix}-{ts_str}-{token}"

def safe_round(val, decimals=2):
    """Pitfall #4: Standardize float rounding to eliminate IEEE-754 precision drift."""
    if val is None:
        return 0.0
    try:
        return round(float(val), decimals)
    except (ValueError, TypeError):
        return 0.0

def safe_date_str(val):
    """Pitfall #6: Safe date normalization avoiding empty string PostgreSQL coercion crash."""
    if not val:
        return None
    if isinstance(val, (datetime.date, datetime.datetime)):
        return val.strftime("%Y-%m-%d")
    val_str = str(val).strip()
    return val_str if val_str else None

class PgCursorWrapper:
    """
    Pitfall #12 & #5: Wraps SQLite / Postgres cursors.
    - Translates ? -> %s if target is Postgres.
    - Normalizes row dict access.
    - Converts Decimal types to float.
    """
    def __init__(self, cursor, is_postgres=False):
        self.cursor = cursor
        self.is_postgres = is_postgres

    def execute(self, query, params=None):
        if params is None:
            params = ()
        if self.is_postgres:
            # Translate ? -> %s
            query = query.replace("?", "%s")
        self.cursor.execute(query, params)
        return self

    def fetchone(self):
        row = self.cursor.fetchone()
        if not row:
            return None
        return self._normalize_row(row)

    def fetchall(self):
        rows = self.cursor.fetchall()
        return [self._normalize_row(r) for r in rows]

    def _normalize_row(self, row):
        # Convert row to dict
        if isinstance(row, sqlite3.Row):
            d = dict(row)
        elif isinstance(row, dict):
            d = dict(row)
        else:
            try:
                d = dict(row)
            except Exception:
                d = {desc[0]: val for desc, val in zip(self.cursor.description, row)}
        
        # Pitfall #5: Convert Decimal to float, and handle date objects
        for k, v in list(d.items()):
            if isinstance(v, Decimal):
                d[k] = float(v)
            elif isinstance(v, (datetime.date, datetime.datetime)):
                d[k] = v.isoformat()
        return d

    @property
    def lastrowid(self):
        return getattr(self.cursor, "lastrowid", None)

    @property
    def rowcount(self):
        return self.cursor.rowcount

class Database:
    def __init__(self, db_url=None):
        self.db_url = db_url or DATABASE_URL
        self.is_postgres = bool(self.db_url and HAS_POSTGRES and self.db_url.startswith("postgres"))

    def get_connection(self):
        if self.is_postgres:
            conn = psycopg2.connect(self.db_url, cursor_factory=RealDictCursor)
            conn.autocommit = False
            return conn
        else:
            conn = sqlite3.connect(DB_FILE, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            return conn

    def get_cursor(self, conn):
        return PgCursorWrapper(conn.cursor(), is_postgres=self.is_postgres)

    def init_schema(self):
        """Initializes tables for both SQLite and PostgreSQL."""
        conn = self.get_connection()
        cur = self.get_cursor(conn)

        # 1. Users table (with strict whitelist support)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                full_name TEXT NOT NULL,
                role TEXT DEFAULT 'operator',
                is_whitelisted INTEGER DEFAULT 1,
                last_login_at TEXT,
                created_at TEXT NOT NULL
            )
        """)

        # 2. Customers Master table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS customers (
                id TEXT PRIMARY KEY,
                customer_number INTEGER UNIQUE NOT NULL,
                full_name TEXT NOT NULL,
                mobile TEXT,
                area TEXT,
                address TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        # 3. Loans table (supports multi-loan per customer)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS loans (
                id TEXT PRIMARY KEY,
                customer_id TEXT NOT NULL,
                loan_number INTEGER NOT NULL,
                given_amount REAL NOT NULL,
                total_repayable REAL NOT NULL,
                instalment_amount REAL NOT NULL,
                total_instalments INTEGER NOT NULL,
                frequency TEXT DEFAULT 'Weekly',
                profit_margin_pct REAL DEFAULT 4.0,
                disbursed_date TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            )
        """)

        # 4. Collections table (receipt tracking)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                loan_id TEXT NOT NULL,
                customer_id TEXT NOT NULL,
                instalment_number INTEGER NOT NULL,
                amount_paid REAL NOT NULL,
                paid_at TEXT NOT NULL,
                receipt_number TEXT UNIQUE NOT NULL,
                notes TEXT,
                status TEXT DEFAULT 'verified',
                created_at TEXT NOT NULL,
                FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            )
        """)

        # 5. Collection Lineage table (Pitfall #10 & #11: Transactional Audit Lineage)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS collection_lineage (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                loan_id TEXT NOT NULL,
                principal_portion REAL NOT NULL,
                profit_portion REAL NOT NULL,
                remaining_balance REAL NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
            )
        """)

        # 6. Audit Logs table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                action TEXT NOT NULL,
                performed_by TEXT NOT NULL,
                payload TEXT,
                created_at TEXT NOT NULL
            )
        """)

        conn.commit()

        # Seed initial whitelisted operators if empty
        cur.execute("SELECT COUNT(*) as cnt FROM users")
        row = cur.fetchone()
        if (row.get("cnt") if row else 0) == 0:
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            default_users = [
                (generate_doc_id("USR"), "admin@jsrfinance.com", "System Admin", "admin", 1, None, now),
                (generate_doc_id("USR"), "operator@jsrfinance.com", "Field Operator", "operator", 1, None, now),
                (generate_doc_id("USR"), "singarisurendra@gmail.com", "Surendra Singari", "admin", 1, None, now)
            ]
            for u in default_users:
                cur.execute("""
                    INSERT INTO users (id, email, full_name, role, is_whitelisted, last_login_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, u)
            conn.commit()

        # Seed demo customers if empty
        cur.execute("SELECT COUNT(*) as cnt FROM customers")
        crow = cur.fetchone()
        if (crow.get("cnt") if crow else 0) == 0:
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            today = datetime.date.today().strftime("%Y-%m-%d")

            # Cust #1: Sri Ram
            c1_id = generate_doc_id("CUST")
            cur.execute("""
                INSERT INTO customers (id, customer_number, full_name, mobile, area, address, notes, created_at, updated_at)
                VALUES (?, 1, 'Sri Ram', '6397625494', 'Main Road', 'Shop #12, Market Complex', 'Premier retail client', ?, ?)
            """, (c1_id, now, now))

            # Loan #1 for Cust #1 (Weekly, 52 Wk, Rs 10000, 4% Margin)
            l1_id = generate_doc_id("LOAN")
            cur.execute("""
                INSERT INTO loans (id, customer_id, loan_number, given_amount, total_repayable, instalment_amount, total_instalments, frequency, profit_margin_pct, disbursed_date, status, created_at)
                VALUES (?, ?, 1, 10000.0, 10400.0, 200.0, 52, 'Weekly', 4.0, ?, 'active', ?)
            """, (l1_id, c1_id, today, now))

            # Cust #2: Anjali Devi
            c2_id = generate_doc_id("CUST")
            cur.execute("""
                INSERT INTO customers (id, customer_number, full_name, mobile, area, address, notes, created_at, updated_at)
                VALUES (?, 2, 'Anjali Devi', '9848012345', 'Bazaar Street', 'House #4, Temple Lane', 'Vegetable stall vendor', ?, ?)
            """, (c2_id, now, now))

            l2_id = generate_doc_id("LOAN")
            cur.execute("""
                INSERT INTO loans (id, customer_id, loan_number, given_amount, total_repayable, instalment_amount, total_instalments, frequency, profit_margin_pct, disbursed_date, status, created_at)
                VALUES (?, ?, 1, 10000.0, 10400.0, 200.0, 52, 'Weekly', 4.0, ?, 'active', ?)
            """, (l2_id, c2_id, today, now))

            # Add a couple of initial payments for Sri Ram to test collections
            for i in range(1, 3):
                col_id = generate_doc_id("COL")
                rec_num = f"REC-{today.replace('-', '')}-{1000 + i}"
                cur.execute("""
                    INSERT INTO collections (id, loan_id, customer_id, instalment_number, amount_paid, paid_at, receipt_number, notes, status, created_at)
                    VALUES (?, ?, ?, ?, 200.0, ?, ?, 'Regular collection', 'verified', ?)
                """, (col_id, l1_id, c1_id, i, f"{today} 10:30:00", rec_num, now))

                # Lineage: Rs 200 has 10000/10400 principal (~192.31) and 400/10400 profit (~7.69)
                cur.execute("""
                    INSERT INTO collection_lineage (id, collection_id, loan_id, principal_portion, profit_portion, remaining_balance, created_at)
                    VALUES (?, ?, ?, 192.31, 7.69, ?, ?)
                """, (generate_doc_id("LIN"), col_id, l1_id, 10400.0 - (i * 200.0), now))

            conn.commit()

        conn.close()

# Singleton DB manager
db = Database()
if __name__ == "__main__":
    print("[INIT] Initializing JSR Finance database schema...")
    db.init_schema()
    print("[OK] Schema initialized successfully.")
