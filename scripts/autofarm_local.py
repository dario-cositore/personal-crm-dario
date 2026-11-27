#!/usr/bin/env python3
"""Autofarm local daemon: top up the approved=0 draft queue to 100 by dispatching
qualified scouted leads to Mach 1 Workflow 1 v14. 100% deterministic, zero LLM calls."""

import argparse
import json
import os
import re
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(BASE_DIR, ".env")
if not os.path.exists(ENV_FILE):
    ENV_FILE = os.path.join(os.path.expanduser("~"), ".ai-enablement-agent", ".env")

def load_env(path):
    out = {}
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            out[k] = v
    return out

ENV = load_env(ENV_FILE)
def getenv(k, default=""):
    return os.environ.get(k, ENV.get(k, default))

AI_HOME = getenv("AI_ENABLEMENT_HOME", os.path.join(os.path.expanduser("~"), ".ai-enablement-agent"))
DB_PATH = getenv("ELITZA_CRM_DB", os.path.join(AI_HOME, "brain", "crm.db"))
CRM_BASE = getenv("CRM_BASE_URL", "http://127.0.0.1:8800")
TOWER_WEBHOOK = getenv("AUTOFARM_TOWER_WEBHOOK", "https://api.mach1ai.com/v3/webhook?workflow_code_id=4f78f1f6-62bb-4622-a032-8589b729d449&environment=production&label=production&timezone=Europe/Rome")
TOWER_API_KEY = getenv("TOWER_WEBHOOK_TOKEN", getenv("MACH1_INTERNAL_API_KEY", ""))
TARGET_QUEUE = int(getenv("AUTOFARM_TARGET_QUEUE", "100"))
MAX_DAILY = int(getenv("AUTOFARM_MAX_DAILY", "115"))
BATCH_SIZE = int(getenv("AUTOFARM_BATCH_SIZE", "6"))
LIMIT = None

AUTO_STOP = getenv("ELITZA_AUTO_STOP_AT", "")

LOCATIONS = ["Castelleone, Italy", "Crema, Italy", "Cremona, Italy", "Lodi, Italy", "Soresina, Italy", "Codogno, Italy"]
QUERIES = ["dentisti", "fisioterapisti", "idraulici", "autofficine", "commercialisti", "avvocati"]

BLOCKED_LOCALS = {"pec", "postacertificata", "posta-certificata", "certificata", "privacy", "dpo", "gdpr", "legale", "legal", "fatture", "fatturazione", "sdi", "noreply", "no-reply", "donotreply", "do-not-reply"}
BLOCKED_DOMAIN_TOKENS = ["legalmail", "arubapec", "telecompost", ".pec."]
ALLOWED_FALLBACK_LOCALS = {"marketing", "amministrazione", "commerciale", "vendite", "lavoraconnoi", "hr", "candidature"}
PREFERRED_LOCALS = {"info", "segreteria", "contatti", "studio", "appuntamenti", "prenotazioni"}

EXCLUDED_BUSINESS_TOKENS = ["agenzia", "web agency", "seo", "social media", "marketing digitale", "software house", "it consultancy", "ai consultancy", "saas", "digital agency"]

SCRAPE_SLUGS = ["contatti", "sede-e-contatti", "contact", "chi-siamo", "lo-studio", "team", "servizi", "prestazioni", "ambulatori", "sedi"]

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def ensure_autofarm_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS autofarm_dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        dispatched_at TEXT NOT NULL,
        execution_id TEXT
    )""")
    conn.commit()

def today_dispatch_count(conn):
    today = datetime.now(timezone.utc).date().isoformat()
    row = conn.execute("SELECT COUNT(*) FROM autofarm_dispatch_log WHERE substr(dispatched_at,1,10)=?", (today,)).fetchone()
    return row[0] if row else 0

def already_dispatched(conn, client_id):
    row = conn.execute("SELECT 1 FROM autofarm_dispatch_log WHERE client_id=?", (client_id,)).fetchone()
    return row is not None

# ---------------------------------------------------------------------------
# Scraping
# ---------------------------------------------------------------------------
import ssl
import urllib.request

def fetch_html_relaxed(url, timeout=12):
    # Stage 1: urllib with relaxed SSL
    try:
        ctx = ssl._create_unverified_context()
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            ct = resp.headers.get("Content-Type", "")
            if "text/html" in ct or "text/plain" in ct:
                data = resp.read().decode("utf-8", "ignore")
                if len(data) >= 50:
                    return data
    except Exception:
        pass
    # Stage 2: curl
    try:
        out = subprocess.run(
            ["curl", "-skL", "--http1.1", "--max-time", str(timeout),
             "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
             "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
             "-H", "Accept-Language: it-IT,it;q=0.9,en;q=0.8",
             url],
            capture_output=True, text=True, timeout=timeout + 5,
        )
        if out.returncode == 0 and out.stdout and len(out.stdout) >= 50:
            return out.stdout
    except Exception:
        pass
    # Stage 3: headless browser
    browser = None
    for b in ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]:
        try:
            subprocess.run(["which", b], check=True, capture_output=True)
            browser = b
            break
        except Exception:
            continue
    if browser:
        try:
            out = subprocess.run(
                [browser, "--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", url],
                capture_output=True, text=True, timeout=15,
            )
            if out.returncode == 0 and out.stdout and len(out.stdout) >= 50:
                return out.stdout
        except Exception:
            pass
    return None

def strip_html(html):
    t = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    t = re.sub(r"<style[\s\S]*?</style>", " ", t, flags=re.I)
    t = re.sub(r"<noscript[\s\S]*?</noscript>", " ", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&quot;", '"').replace("&#39;", "'")
    t = re.sub(r"\s+", " ", t).strip()
    return t

def is_blocked_url(url):
    lower = url.lower()
    for p in ["/alid/v1/widget.js", "/intake/", "/checkout", "/payment", "/pay", "waffo", "paypal", "pec@", "legalmail", "postacertificata", "certificata"]:
        if p in lower:
            return True
    return False

def is_blocked_email(email):
    email = email.lower()
    local = email.split("@")[0]
    if local in {"pec", "postacertificata", "posta-certificata", "certificata", "privacy", "dpo", "gdpr", "legale", "legal", "fatture", "fatturazione", "sdi", "noreply", "no-reply", "donotreply", "do-not-reply"}:
        return True
    if "legalmail" in email or "arubapec" in email or "telecompost" in email or ".pec." in email:
        return True
    return False

def extract_emails(text, html):
    found = set()
    for m in re.finditer(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", text + " " + html, re.I):
        em = m.group(0).lower()
        if not is_blocked_email(em):
            found.add(em)
    for m in re.finditer(r"mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})", html, re.I):
        em = m.group(1).lower()
        if not is_blocked_email(em):
            found.add(em)
    # prioritize preferred locals
    def prio(e):
        local = e.split("@")[0]
        if local in PREFERRED_LOCALS:
            return 0
        if local in ALLOWED_FALLBACK_LOCALS:
            return 1
        return 2
    return sorted(found, key=prio)

def scrape_site(raw_url):
    result = {"fetch_ok": False, "site_text": "", "pages_fetched": [], "extracted_emails": []}
    if not raw_url:
        return result
    host = raw_url.strip().replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0].lower()
    if not host or " " in host:
        return result

    candidate_urls = [f"https://www.{host}/", f"https://{host}/"]
    for slug in SCRAPE_SLUGS:
        candidate_urls.append(f"https://www.{host}/{slug}")
        candidate_urls.append(f"https://{host}/{slug}")

    fetched = []
    seen = set()
    deadline = time.time() + 18
    for url in candidate_urls:
        if time.time() > deadline:
            break
        if is_blocked_url(url):
            continue
        try:
            u = urllib.parse.urlparse(url)
            key = u.hostname.replace("www.", "") + u.path.rstrip("/")
        except Exception:
            continue
        if key in seen:
            continue
        seen.add(key)
        html = fetch_html_relaxed(url)
        if not html:
            continue
        text = strip_html(html)
        if len(text) < 50:
            continue
        fetched.append((url, text, html))

    # homepage = first successful; subpages = next non-homepage (up to 2)
    home_entry = fetched[0] if fetched else None
    sub_entries = []
    for i in range(1, len(fetched)):
        if len(sub_entries) >= 2:
            break
        try:
            u = urllib.parse.urlparse(fetched[i][0])
            if u.path in ("", "/"):
                continue
            sub_entries.append(fetched[i])
        except Exception:
            continue

    combined = ""
    pages_fetched = []
    all_emails = set()
    if home_entry:
        cap = min(len(home_entry[1]), 12000)
        combined += home_entry[1][:cap]
        pages_fetched.append(home_entry[0])
        for e in extract_emails(home_entry[1], home_entry[2]):
            all_emails.add(e)
    for sub in sub_entries:
        if len(combined) >= 20000:
            break
        remaining = 20000 - len(combined)
        cap = min(len(sub[1]), 5000, remaining)
        if cap <= 0:
            break
        combined += "\n\n" + sub[1][:cap]
        pages_fetched.append(sub[0])
        for e in extract_emails(sub[1], sub[2]):
            all_emails.add(e)

    result["site_text"] = combined[:20000]
    result["pages_fetched"] = pages_fetched
    result["extracted_emails"] = sorted(all_emails, key=lambda e: (0 if e.split("@")[0] in PREFERRED_LOCALS else (1 if e.split("@")[0] in ALLOWED_FALLBACK_LOCALS else 2), e))
    result["fetch_ok"] = len(fetched) > 0
    return result

# ---------------------------------------------------------------------------
# Scouting (reuse CRM HTTP API)
# ---------------------------------------------------------------------------
def crm_post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(CRM_BASE + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

def crm_get(path):
    req = urllib.request.Request(CRM_BASE + path, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

def run_scouting(conn):
    # check scouted count
    cur = conn.execute("SELECT COUNT(*) FROM clients WHERE status='scouted'")
    scouted_count = cur.fetchone()[0]
    if scouted_count >= BATCH_SIZE * 3:
        return
    locations = LOCATIONS[:]
    queries = QUERIES[:]
    # rotate: use a simple cursor based on count
    idx = scouted_count % len(locations)
    for i in range(3):
        loc = locations[(idx + i) % len(locations)]
        q = queries[(idx + i) % len(queries)]
        try:
            res = crm_post("/api/scout", {"location": loc, "query": q, "limit": 15})
            businesses = res.get("businesses", [])
            for b in businesses:
                name = b.get("name")
                if not name:
                    continue
                # skip excluded
                lower = (name + " " + (b.get("category") or "")).lower()
                if any(tok in lower for tok in EXCLUDED_BUSINESS_TOKENS):
                    continue
                try:
                    crm_post("/api/clients", {
                        "name": name,
                        "website": b.get("website"),
                        "phone": b.get("phone"),
                        "address": b.get("address"),
                        "email": b.get("email"),
                        "vertical": b.get("category"),
                        "language": "it",
                        "source": "autofarm",
                        "status": "scouted",
                    })
                except Exception as e:
                    print(f"  addClient error: {e}", file=sys.stderr)
        except Exception as e:
            print(f"  scout error {loc}/{q}: {e}", file=sys.stderr)

# ---------------------------------------------------------------------------
# Pre-filter
# ---------------------------------------------------------------------------
def is_excluded_business(name, vertical, website):
    text = f"{name or ''} {vertical or ''} {website or ''}".lower()
    return any(tok in text for tok in EXCLUDED_BUSINESS_TOKENS)

def pick_email(emails):
    # prefer operational, then fallback, block hard-blocked (already filtered)
    if not emails:
        return None
    for e in emails:
        local = e.split("@")[0]
        if local in PREFERRED_LOCALS:
            return e
    for e in emails:
        local = e.split("@")[0]
        if local in ALLOWED_FALLBACK_LOCALS:
            return e
    # any non-blocked
    return emails[0] if emails else None

def has_operational_detail(text):
    if not text or len(text) < 250:
        return False
    # concrete operational details
    keywords = ["servizi", "contatti", "orari", "prenot", "telefono", "email", "indirizzo", "studio", "clinica", "ambulatorio", "preventiv", "appuntament"]
    low = text.lower()
    return any(k in low for k in keywords)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="max leads to dispatch this run")
    parser.add_argument("--dry-run", action="store_true", help="do not dispatch, just print")
    args = parser.parse_args()
    global LIMIT
    LIMIT = args.limit

    # 1. auto stop
    if AUTO_STOP:
        try:
            stop = datetime.fromisoformat(AUTO_STOP.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) >= stop:
                print("ELITZA_AUTO_STOP_AT passed; exiting.")
                return
        except Exception:
            pass

    conn = db()
    ensure_autofarm_table(conn)

    # 2. queue gate
    try:
        cur = conn.execute("SELECT COUNT(*) FROM pipeline WHERE approved = 0 AND draft_path IS NOT NULL")
        waiting = cur.fetchone()[0]
    except Exception:
        waiting = 0
    if waiting >= TARGET_QUEUE:
        print(f"Queue full ({waiting} >= {TARGET_QUEUE}); exiting.")
        conn.close()
        return

    # daily cap
    if today_dispatch_count(conn) >= MAX_DAILY:
        print(f"Daily cap reached ({MAX_DAILY}); exiting.")
        conn.close()
        return

    # 3. auto-replenish scouted
    try:
        run_scouting(conn)
    except Exception as e:
        print(f"scouting error: {e}", file=sys.stderr)

    # 4. process candidates
    batch = LIMIT if LIMIT else BATCH_SIZE
    # get scouted leads not yet dispatched
    rows = conn.execute(
        """SELECT c.id, c.name, c.website, c.email, c.address, c.language, c.notes, c.vertical
           FROM clients c
           WHERE c.status = 'scouted'
             AND c.id NOT IN (SELECT client_id FROM autofarm_dispatch_log)
           ORDER BY c.id ASC LIMIT ?""",
        (batch * 4,),
    ).fetchall()

    dispatched_this_run = 0
    for r in rows:
        if dispatched_this_run >= batch:
            break
        if today_dispatch_count(conn) >= MAX_DAILY:
            print("Daily cap reached mid-run; stopping.")
            break
        if waiting + dispatched_this_run >= TARGET_QUEUE:
            print("Queue reached target; stopping.")
            break

        client_id = r["id"]
        name = r["name"] or ""
        website = r["website"]
        email = r["email"]
        city = (r["address"] or "").split(",")[-1].strip() if r["address"] else ""
        notes = r["notes"] or ""
        vertical = r["vertical"] or ""

        # exclude non-target
        if is_excluded_business(name, vertical, website):
            conn.execute("UPDATE clients SET status='disqualified', updated_at=? WHERE id=?", (datetime.now(timezone.utc).isoformat(), client_id))
            conn.commit()
            continue

        # scrape
        scraped_text = ""
        scraped_emails = []
        if website:
            sc = scrape_site(website)
            scraped_text = sc["site_text"]
            scraped_emails = sc["extracted_emails"]
            # store scraped text? (best effort, no column; skip)

        # pre-filter
        clean_email = None
        if email and not is_blocked_email(email):
            clean_email = email
        if not clean_email and scraped_emails:
            clean_email = pick_email(scraped_emails)

        ok_email = clean_email is not None
        ok_text = has_operational_detail(scraped_text)
        ok_notes = len(notes.strip()) > 120

        if not ((ok_email and ok_text) or ok_notes):
            # fail: move out of scouted
            new_status = "manual_check"
            conn.execute("UPDATE clients SET status=?, notes=COALESCE(notes,'') || '\n[autofarm] disqualified: no usable email/text', updated_at=? WHERE id=?",
                         (new_status, datetime.now(timezone.utc).isoformat(), client_id))
            conn.commit()
            continue

        if not clean_email:
            clean_email = scraped_emails[0] if scraped_emails else (email or "")

        payload = {
            "event": "outbound_prep",
            "client": {
                "id": str(client_id),
                "name": name,
                "website": website or "",
                "email": clean_email or "",
                "city": city,
                "language": "it",
                "notes": notes,
            },
            "scraped_text": scraped_text,
            "scraped_emails": scraped_emails,
        }

        if args.dry_run:
            print(f"[dry-run] would dispatch client {client_id} ({name})")
            dispatched_this_run += 1
            continue

        # dispatch to Mach 1
        try:
            req = urllib.request.Request(
                TOWER_WEBHOOK + ("&" if "?" in TOWER_WEBHOOK else "?"),
                data=json.dumps(payload).encode(),
                headers={
                    "Content-Type": "application/json",
                    "api-key": TOWER_API_KEY,
                    "bot-identifier": "personal_crm_iyym",
                    "timezone": "Europe/Rome",
                },
                method="POST",
            )
            # ensure workflow_code_id in url
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode()
                try:
                    j = json.loads(body)
                    exec_id = j.get("execution_id") or j.get("id") or j.get("run_id")
                except Exception:
                    exec_id = None
                conn.execute(
                    "INSERT INTO autofarm_dispatch_log (client_id, dispatched_at, execution_id) VALUES (?,?,?)",
                    (client_id, datetime.now(timezone.utc).isoformat(), exec_id),
                )
                conn.commit()
                dispatched_this_run += 1
                waiting += 1
                print(f"dispatched client {client_id} ({name}) exec={exec_id}")
        except Exception as e:
            print(f"dispatch error client {client_id}: {e}", file=sys.stderr)
            # mark as failed? leave for retry next run

        time.sleep(1.5)

    conn.close()
    print(f"Run complete. Dispatched this run: {dispatched_this_run}")

if __name__ == "__main__":
    main()
