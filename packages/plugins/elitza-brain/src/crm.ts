/**
 * Elitza Brain — the AI Enablement CRM (Task C).
 *
 * Its own database (`~/.ai-enablement-agent/brain/crm.db`), deliberately separate from
 * the soul: client rows are case data carrying names, phones and emails, so
 * they keep their own file — independently backed up, exported or wiped,
 * and never indexed into the memory FTS.
 *
 * Tables:
 *   clients             one row per business: identity, scout data, stage, score
 *   client_interactions every touch and reply (Tasks D/E record them)
 *   client_assets       proposals, workbooks, SOPs, invoices (Task G)
 *
 * Status lifecycle, in order (Tasks D-G share it):
 *   scouted -> contacted -> followup_1 -> followup_2 -> followup_3
 *     -> yes  -> diagnose -> proposal -> workbook -> scheduled -> payment -> done
 *     -> no   -> stale
 *
 * Scores are 0-100 (Elitza's qualification), deal_value is whole euros.
 * Nothing here ever sends anything — contact is the pipeline's job.
 */

import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { BRAIN_DIR, AI_ENABLEMENT_HOME as _AI_ENABLEMENT_HOME, nowISO } from "./db.js"

export const CRM_DB_PATH = `${BRAIN_DIR}/crm.db`

/**
 * Where the CRM opens. Resolved at open time, not at import time, because
 * `AI_ENABLEMENT_HOME` (and therefore CRM_DB_PATH) is frozen the moment db.js loads —
 * a test that sets it later would otherwise reach the operator's real records.
 * Same override shape as GOOGLE_PLACES_URL / RESEND_URL.
 */
export function crmDbPath(): string {
  return process.env.ELITZA_CRM_DB || CRM_DB_PATH
}

export const CLIENT_STATUSES = [
  "scouted",
  "enriched",
  "contacted",
  "followup_1",
  "followup_2",
  "followup_3",
  "yes",
  "no",
  "stale",
  "diagnose",
  "proposal",
  "workbook",
  "scheduled",
  "payment",
  "done",
] as const

export type ClientStatus = string

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      birthday TEXT,
      notes TEXT,
      roles TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS people_email ON people(email);
  CREATE INDEX IF NOT EXISTS people_name ON people(name);

  CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      vertical TEXT,
      status TEXT NOT NULL DEFAULT 'scouted',
      score INTEGER,
      address TEXT,
      phone TEXT,
      website TEXT,
      email TEXT,
      rating REAL,
      rating_count INTEGER,
      category TEXT,
      google_maps TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      notes TEXT,
      deal_value INTEGER,
      currency TEXT NOT NULL DEFAULT 'EUR',
      last_contact TEXT,
      next_action TEXT,
      next_action_at TEXT,
      linkedin TEXT,
      twitter TEXT,
      facebook TEXT,
      instagram TEXT,
      company TEXT,
      priority_tier TEXT,
      tier INTEGER,
      tier_label TEXT,
      risk_level TEXT,
      risk_score INTEGER,
      risk_notes TEXT,
      tech_stack TEXT,
      revenue_estimate TEXT,
      employee_count TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      offer_track TEXT,
      pain_category TEXT,
      playbook_id TEXT,
      offer_rationale TEXT,
      enrichment_json TEXT,
      enrichment_version TEXT,
      enriched_at TEXT,
      outreach_route TEXT,
      contact_name TEXT,
      pec_email TEXT,
      person_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS client_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      direction TEXT,
      channel TEXT,
      status TEXT,
      subject TEXT,
      body TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS client_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT,
      status TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS clients_status ON clients(status);
  CREATE INDEX IF NOT EXISTS clients_next_action ON clients(next_action_at);
  CREATE INDEX IF NOT EXISTS interactions_client ON client_interactions(client_id, occurred_at);
  CREATE INDEX IF NOT EXISTS assets_client ON client_assets(client_id);

  -- Task D: the outreach pipeline. Stage mirrors clients.status (kept in
  -- sync by outreach.ts); this table owns the cadence bookkeeping and the
  -- draft file the human reviews before anything is approved to send.
  CREATE TABLE IF NOT EXISTS pipeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
      stage TEXT NOT NULL DEFAULT 'scouted',
      channel TEXT NOT NULL DEFAULT 'email',
      touch INTEGER NOT NULL DEFAULT 0,
      draft_path TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      queued_touch INTEGER NOT NULL DEFAULT 0,
      variant TEXT,
      last_touch_at TEXT,
      next_touch_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS pipeline_stage ON pipeline(stage);
  CREATE INDEX IF NOT EXISTS pipeline_next ON pipeline(next_touch_at);

  -- Custom fields: vertical-specific attributes without schema changes.
  CREATE TABLE IF NOT EXISTS client_custom_fields (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (client_id, key)
  );

  -- Deals: multiple opportunities per client.
  CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'open',
      value INTEGER,
      currency TEXT NOT NULL DEFAULT 'EUR',
      probability INTEGER,
      close_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deals_client ON deals(client_id);
  CREATE INDEX IF NOT EXISTS deals_stage ON deals(stage);

  -- Tags.
  CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS client_tags (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (client_id, tag_id)
  );

  -- Audit log: who changed what, when.
  CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      diff TEXT,
      actor TEXT NOT NULL DEFAULT 'elitza',
      created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_entity ON audit_log(entity, entity_id);

  -- Cloud storage connections for continuous backup sync.
  CREATE TABLE IF NOT EXISTS cloud_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      account_label TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      folder_id TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      last_sync TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cloud_provider ON cloud_accounts(provider);

  -- Turn cost tracking.
  CREATE TABLE IF NOT EXISTS turn_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turn_costs_session ON turn_costs(session_id);

  -- Triggered email engine: event-driven touches beyond the fixed cadence.
  CREATE TABLE IF NOT EXISTS email_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      event TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      cooldown_days INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS triggers_client ON email_triggers(client_id);
  CREATE INDEX IF NOT EXISTS triggers_status ON email_triggers(status);

  CREATE TABLE IF NOT EXISTS scout_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      query TEXT NOT NULL,
      limit_n INTEGER,
      sources TEXT,
      results TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS scout_runs_created ON scout_runs(created_at);

  CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      filter TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS segments_name ON segments(name);

  -- Mail: a Gmail-like store for all email (inbox/sent/drafts/trash) with
  -- auto-linking to CRM clients/orgs by address.
  CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder TEXT NOT NULL DEFAULT 'inbox',
      direction TEXT NOT NULL DEFAULT 'in',
      from_addr TEXT,
      to_addr TEXT,
      cc TEXT,
      bcc TEXT,
      subject TEXT,
      body TEXT,
      html TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      company TEXT,
      thread_id TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      labels TEXT,
      resend_id TEXT,
      in_reply_to INTEGER REFERENCES emails(id) ON DELETE SET NULL,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      gmail_id TEXT,
      provider TEXT NOT NULL DEFAULT 'local'
  );
  CREATE INDEX IF NOT EXISTS emails_folder ON emails(folder);
  CREATE INDEX IF NOT EXISTS emails_client ON emails(client_id);
  CREATE INDEX IF NOT EXISTS emails_occurred ON emails(occurred_at);
  CREATE INDEX IF NOT EXISTS emails_thread ON emails(thread_id);

  CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'product',
      description TEXT,
      price INTEGER,
      currency TEXT NOT NULL DEFAULT 'EUR',
      url TEXT,
      audience TEXT,
      deliverable TEXT,
      notes TEXT,
      strategy TEXT,
      strategy_generated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS products_type ON products(type);
  CREATE INDEX IF NOT EXISTS products_name ON products(name);

  CREATE TABLE IF NOT EXISTS mkt_email_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'broadcast',
      status TEXT NOT NULL DEFAULT 'draft',
      subject TEXT,
      body TEXT,
      audience TEXT,
      segment_id INTEGER,
      product_id INTEGER,
      scheduled_at TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      open_count INTEGER NOT NULL DEFAULT 0,
      click_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mkt_email_campaigns_status ON mkt_email_campaigns(status);

  CREATE TABLE IF NOT EXISTS mkt_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'meta',
      status TEXT NOT NULL DEFAULT 'draft',
      budget REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      spend REAL NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      conversions INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      product_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mkt_ads_status ON mkt_ads(status);
  CREATE INDEX IF NOT EXISTS mkt_ads_platform ON mkt_ads(platform);

  CREATE TABLE IF NOT EXISTS mkt_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'linkedin',
      status TEXT NOT NULL DEFAULT 'idea',
      content TEXT,
      scheduled_date TEXT,
      published_url TEXT,
      product_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mkt_content_status ON mkt_content(status);
  CREATE INDEX IF NOT EXISTS mkt_content_platform ON mkt_content(platform);

  CREATE TABLE IF NOT EXISTS mkt_reachout_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      segment_id INTEGER,
      product_id INTEGER,
      subject TEXT,
      body TEXT,
      audience_filter TEXT,
      daily_cap INTEGER NOT NULL DEFAULT 30,
      buffer_min_sec INTEGER NOT NULL DEFAULT 120,
      buffer_max_sec INTEGER NOT NULL DEFAULT 300,
      batch_size INTEGER NOT NULL DEFAULT 10,
      warmup_stage INTEGER NOT NULL DEFAULT 2,
      start_date TEXT,
      from_email TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mkt_reachout_campaigns_status ON mkt_reachout_campaigns(status);

  CREATE TABLE IF NOT EXISTS mkt_reachout_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      batch_no INTEGER NOT NULL DEFAULT 1,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      sent_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES mkt_reachout_campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS mkt_reachout_queue_campaign ON mkt_reachout_queue(campaign_id, scheduled_at);
  CREATE INDEX IF NOT EXISTS mkt_reachout_queue_status ON mkt_reachout_queue(status, scheduled_at);

  CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'client_to_client',
      status TEXT NOT NULL DEFAULT 'pending',
      referrer_kind TEXT NOT NULL DEFAULT 'client',
      referrer_client_id INTEGER,
      referrer_person_id INTEGER,
      referrer_name TEXT,
      referee_kind TEXT NOT NULL DEFAULT 'client',
      referee_client_id INTEGER,
      referee_name TEXT,
      total_value REAL,
      split_percent REAL,
      split_amount REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      paid_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (referrer_client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (referrer_person_id) REFERENCES people(id) ON DELETE SET NULL,
      FOREIGN KEY (referee_client_id) REFERENCES clients(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS referrals_type ON referrals(type);
  CREATE INDEX IF NOT EXISTS referrals_status ON referrals(status);
  CREATE INDEX IF NOT EXISTS referrals_referrer_client ON referrals(referrer_client_id);
  CREATE INDEX IF NOT EXISTS referrals_referee_client ON referrals(referee_client_id);

  CREATE TABLE IF NOT EXISTS referrers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      birthday TEXT,
      important_dates TEXT,
      client_id INTEGER,
      tier TEXT NOT NULL DEFAULT 'bronze',
      points INTEGER NOT NULL DEFAULT 0,
      badges TEXT,
      notes TEXT,
      joined_at TEXT NOT NULL,
      last_thank_you_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS referrers_tier ON referrers(tier);
  CREATE INDEX IF NOT EXISTS referrers_person ON referrers(person_id);
  CREATE INDEX IF NOT EXISTS referrers_client ON referrers(client_id);
  CREATE INDEX IF NOT EXISTS referrers_birthday ON referrers(birthday);

  CREATE TABLE IF NOT EXISTS referral_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      referral_id INTEGER,
      client_id INTEGER,
      event_type TEXT NOT NULL DEFAULT 'referral',
      value REAL,
      points INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (referrer_id) REFERENCES referrers(id) ON DELETE CASCADE,
      FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE SET NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS referral_events_referrer ON referral_events(referrer_id);
  CREATE INDEX IF NOT EXISTS referral_events_type ON referral_events(event_type);

  CREATE TABLE IF NOT EXISTS referral_thank_yous (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (referrer_id) REFERENCES referrers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS referral_thank_yous_referrer ON referral_thank_yous(referrer_id);
  CREATE INDEX IF NOT EXISTS referral_thank_yous_status ON referral_thank_yous(status);
`
/** A row shipped before this column existed must gain it, or the cadence reads null. */
function migrate(db: Database): void {
  const pipelineCols = db.query("PRAGMA table_info(pipeline)").all() as { name: string }[]
  if (!pipelineCols.some((column) => column.name === "queued_touch")) {
    db.exec("ALTER TABLE pipeline ADD COLUMN queued_touch INTEGER NOT NULL DEFAULT 0")
  }
  if (!pipelineCols.some((column) => column.name === "variant")) {
    db.exec("ALTER TABLE pipeline ADD COLUMN variant TEXT")
  }
  // emails table migrations
  try {
    const emailCols = db.query("PRAGMA table_info(emails)").all() as { name: string }[]
    if (emailCols.length && !emailCols.some((c) => c.name === "gmail_id")) {
      db.exec("ALTER TABLE emails ADD COLUMN gmail_id TEXT")
    }
    if (emailCols.length && !emailCols.some((c) => c.name === "provider")) {
      db.exec("ALTER TABLE emails ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'")
    }
  } catch {}
  const clientCols = db.query("PRAGMA table_info(clients)").all() as { name: string }[]
  const newCols: { name: string; type: string }[] = [
    { name: "linkedin", type: "TEXT" },
    { name: "twitter", type: "TEXT" },
    { name: "facebook", type: "TEXT" },
    { name: "instagram", type: "TEXT" },
    { name: "company", type: "TEXT" },
    { name: "priority_tier", type: "TEXT" },
    { name: "tier", type: "INTEGER" },
    { name: "tier_label", type: "TEXT" },
    { name: "risk_level", type: "TEXT" },
    { name: "risk_score", type: "INTEGER" },
    { name: "risk_notes", type: "TEXT" },
    { name: "tech_stack", type: "TEXT" },
    { name: "revenue_estimate", type: "TEXT" },
    { name: "employee_count", type: "TEXT" },
    { name: "language", type: "TEXT" },
    { name: "offer_track", type: "TEXT" },
    { name: "offer_rationale", type: "TEXT" },
    { name: "pain_category", type: "TEXT" },
    { name: "playbook_id", type: "TEXT" },
    { name: "enrichment_json", type: "TEXT" },
    { name: "enrichment_version", type: "TEXT" },
    { name: "enriched_at", type: "TEXT" },
    { name: "outreach_route", type: "TEXT" },
    { name: "contact_name", type: "TEXT" },
    { name: "pec_email", type: "TEXT" },
  ]
  for (const col of newCols) {
    if (!clientCols.some((c) => c.name === col.name)) {
      db.exec(`ALTER TABLE clients ADD COLUMN ${col.name} ${col.type}`)
    }
  }
  // Products strategy columns (added with the System Strategy feature).
  try {
    const productCols = db.query("PRAGMA table_info(products)").all() as { name: string }[]
    if (productCols.length && !productCols.some((c) => c.name === "strategy")) {
      db.exec("ALTER TABLE products ADD COLUMN strategy TEXT")
    }
    if (productCols.length && !productCols.some((c) => c.name === "strategy_generated_at")) {
      db.exec("ALTER TABLE products ADD COLUMN strategy_generated_at TEXT")
    }
  } catch { /* products table may not exist yet */ }
  // mkt_ads revenue column (auto-calculated metrics).
  try {
    const adCols = db.query("PRAGMA table_info(mkt_ads)").all() as { name: string }[]
    if (adCols.length && !adCols.some((c) => c.name === "revenue")) {
      db.exec("ALTER TABLE mkt_ads ADD COLUMN revenue REAL NOT NULL DEFAULT 0")
    }
  } catch { /* mkt_ads table may not exist yet */ }
  // referrals -> referrer link
  try {
    const refCols = db.query("PRAGMA table_info(referrals)").all() as { name: string }[]
    if (refCols.length && !refCols.some((c) => c.name === "referrer_id")) {
      db.exec("ALTER TABLE referrals ADD COLUMN referrer_id INTEGER")
    }
    if (refCols.length && !refCols.some((c) => c.name === "referrer_person_id")) {
      db.exec("ALTER TABLE referrals ADD COLUMN referrer_person_id INTEGER")
    }
  } catch { /* referrals table may not exist yet */ }
  // people master: person_id on clients
  try {
    const cCols = db.query("PRAGMA table_info(clients)").all() as { name: string }[]
    if (cCols.length && !cCols.some((c) => c.name === "person_id")) {
      db.exec("ALTER TABLE clients ADD COLUMN person_id INTEGER")
    }
  } catch {}
  // people master: person_id on referrers
  try {
    const rCols = db.query("PRAGMA table_info(referrers)").all() as { name: string }[]
    if (rCols.length && !rCols.some((c) => c.name === "person_id")) {
      db.exec("ALTER TABLE referrers ADD COLUMN person_id INTEGER")
    }
  } catch {}
  // backfill people from clients without person_id
  try {
    const orphanClients = db.query("SELECT * FROM clients WHERE person_id IS NULL").all() as any[]
    for (const c of orphanClients) {
      const now = nowISO()
      const res = db.run("INSERT INTO people (name,email,phone,birthday,notes,roles,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        [c.name, c.email ?? null, c.phone ?? null, null, c.notes ?? null, JSON.stringify(["client"]), now, now])
      db.run("UPDATE clients SET person_id = ? WHERE id = ?", [Number(res.lastInsertRowid), c.id])
    }
  } catch {}
  // backfill people from referrers without person_id
  try {
    const orphanRefs = db.query("SELECT * FROM referrers WHERE person_id IS NULL").all() as any[]
    for (const r of orphanRefs) {
      const now = nowISO()
      const res = db.run("INSERT INTO people (name,email,phone,birthday,notes,roles,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        [r.name, r.email ?? null, r.phone ?? null, r.birthday ?? null, r.notes ?? null, JSON.stringify(["referrer"]), now, now])
      db.run("UPDATE referrers SET person_id = ? WHERE id = ?", [Number(res.lastInsertRowid), r.id])
    }
  } catch {}
}

let instance: Database | undefined
let instancePath: string | undefined

/** Open (or return) the single connection to the CRM database. */
export function ensureAppSettingsTable(): void {
  try {
    crmDb().run("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)")
    const row = crmDb().query("SELECT value FROM app_settings WHERE key = 'autofarm_enabled'").get() as any
    if (!row) {
      crmDb().run("INSERT INTO app_settings (key, value, updated_at) VALUES ('autofarm_enabled', '0', ?)", [new Date().toISOString()])
    }
  } catch { /* best effort */ }
}

export function getAppSetting(key: string): string | null {
  ensureAppSettingsTable()
  try {
    const row = crmDb().query("SELECT value FROM app_settings WHERE key = ?").get(key) as any
    if (!row) return null
    return row.value ?? null
  } catch { return null }
}

export function setAppSetting(key: string, value: string): void {
  ensureAppSettingsTable()
  crmDb().run("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [key, value, new Date().toISOString()])
}

export function crmDb(): Database {
  const file = crmDbPath()
  if (instance && instancePath === file) return instance
  // New db path (e.g. in tests) -> close old connection and open fresh.
  try { instance?.close() } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const conn = new Database(file, { create: true })
  conn.exec("PRAGMA journal_mode=WAL")
  conn.exec("PRAGMA foreign_keys=ON")
  conn.exec(SCHEMA)
  migrate(conn)
  instance = conn
  instancePath = file
  return conn
}

export interface Client {
  id: number
  name: string
  vertical: string | null
  status: string
  score: number | null
  address: string | null
  phone: string | null
  website: string | null
  email: string | null
  rating: number | null
  rating_count: number | null
  category: string | null
  google_maps: string | null
  source: string
  notes: string | null
  deal_value: number | null
  currency: string
  last_contact: string | null
  next_action: string | null
  next_action_at: string | null
  linkedin: string | null
  twitter: string | null
  facebook: string | null
  instagram: string | null
  company: string | null
  priority_tier: string | null
  tier: number | null
  tier_label: string | null
  risk_level: string | null
  risk_score: number | null
  risk_notes: string | null
  tech_stack: string | null
  revenue_estimate: string | null
  employee_count: string | null
  language: string
  offer_track: string | null
  offer_rationale: string | null
  pain_category: string | null
  playbook_id: string | null
  enrichment_json: string | null
  enrichment_version: string | null
  enriched_at: string | null
  outreach_route: string | null
  contact_name: string | null
  pec_email: string | null
  created_at: string
  updated_at: string
}

export interface ClientInput {
  name: string
  vertical?: string
  status?: string
  score?: number
  address?: string
  phone?: string
  website?: string
  email?: string
  rating?: number
  rating_count?: number
  category?: string
  google_maps?: string
  source?: string
  notes?: string
  deal_value?: number
  next_action?: string
  next_action_at?: string
  linkedin?: string
  twitter?: string
  facebook?: string
  instagram?: string
  company?: string
  priority_tier?: string
  tier?: number
  tier_label?: string
  risk_level?: string
  risk_score?: number
  risk_notes?: string
  tech_stack?: string
  revenue_estimate?: string
  employee_count?: string
  language?: string
  offer_track?: string
  offer_rationale?: string
  pain_category?: string
  playbook_id?: string
  enrichment_json?: string
  enrichment_version?: string
  enriched_at?: string
  outreach_route?: string
  contact_name?: string
  pec_email?: string
}

export interface Interaction {
  id: number
  client_id: number
  kind: string
  direction: string | null
  channel: string | null
  status: string | null
  subject: string | null
  body: string | null
  occurred_at: string
  created_at: string
}

export interface InteractionInput {
  kind: string
  direction?: string
  channel?: string
  status?: string
  subject?: string
  body?: string
  occurred_at?: string
}

export interface Email {
  id: number
  folder: string
  direction: string
  from_addr: string | null
  to_addr: string | null
  cc: string | null
  bcc: string | null
  subject: string | null
  body: string | null
  html: string | null
  occurred_at: string
  created_at: string
  updated_at: string
  client_id: number | null
  company: string | null
  thread_id: string | null
  is_read: number
  is_starred: number
  labels: string | null
  resend_id: string | null
  gmail_id: string | null
  provider: string
  in_reply_to: number | null
  has_attachments: number
}

export interface EmailInput {
  folder?: string
  direction?: string
  from_addr?: string
  to_addr?: string
  cc?: string
  bcc?: string
  subject?: string
  body?: string
  html?: string
  occurred_at?: string
  client_id?: number | null
  company?: string
  thread_id?: string
  is_read?: number
  is_starred?: number
  labels?: string
  resend_id?: string
  gmail_id?: string
  provider?: string
  in_reply_to?: number | null
  has_attachments?: number
}

export interface ClientAsset {
  id: number
  client_id: number
  kind: string
  name: string
  path: string | null
  status: string | null
  notes: string | null
  created_at: string
}

export interface AssetInput {
  kind: string
  name: string
  path?: string
  status?: string
  notes?: string
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

function assertStatus(status: string): ClientStatus {
  if (!status || !status.trim()) throw new Error("Status cannot be empty.")
  return status as ClientStatus
}

function rows<T>(sql: string, params: unknown[] = []): T[] {
  return crmDb().query(sql).all(...(params as never[])) as T[]
}

function row<T>(sql: string, params: unknown[] = []): T | undefined {
  return crmDb().query(sql).get(...(params as never[])) as T | undefined
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Normalize a website URL: strip scheme, www., query/hash, trailing slash. */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null
  let v = raw.trim()
  if (!v) return null
  v = v.replace(/^https?:\/\//i, "")
  v = v.replace(/^www\./i, "")
  v = v.split("?")[0].split("#")[0]
  v = v.replace(/\/+$/, "")
  return v || null
}

/**
 * Insert a client, or return the existing one when the same business is
 * already in the CRM: a website match wins (scout data always has one when
 * the business has a site), otherwise name + address must both match.
 */
export function addClient(input: ClientInput): { client: Client; created: boolean } {
  const name = input.name.trim()
  if (!name) throw new Error("A client needs a name.")
  const status = assertStatus(input.status ?? "scouted")
  const website = normalizeWebsite(input.website?.trim() || null)
  const address = input.address?.trim() || null

  const existing = website
    ? row<Client>("SELECT * FROM clients WHERE website = ? LIMIT 1", [website])
    : address
      ? row<Client>("SELECT * FROM clients WHERE name = ? AND address = ? LIMIT 1", [name, address])
      : row<Client>("SELECT * FROM clients WHERE name = ? AND address IS NULL LIMIT 1", [name])
  if (existing) return { client: existing, created: false }

  const now = nowISO()
  // One list, used for both the column names and the placeholders: a second
  // copy is how the social/risk columns shipped with 29 columns and 28 values.
  const columns = [
    "name",
    "vertical",
    "status",
    "score",
    "address",
    "phone",
    "website",
    "email",
    "rating",
    "rating_count",
    "category",
    "google_maps",
    "source",
    "notes",
    "deal_value",
    "next_action",
    "next_action_at",
    "linkedin",
    "twitter",
    "facebook",
    "instagram",
    "company",
    "priority_tier",
    "tier",
    "tier_label",
    "risk_level",
    "risk_score",
    "risk_notes",
    "tech_stack",
    "revenue_estimate",
    "employee_count",
    "language",
    "offer_track",
    "offer_rationale",
    "pain_category",
    "playbook_id",
    "enrichment_json",
    "enrichment_version",
    "enriched_at",
    "outreach_route",
    "contact_name",
    "pec_email",
    "created_at",
    "updated_at",
  ]
  const result = crmDb()
    .run(
      `INSERT INTO clients (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      [
        name,
        input.vertical ?? null,
        status,
        input.score ?? null,
        address,
        input.phone ?? null,
        website,
        input.email ?? null,
        input.rating ?? null,
        input.rating_count ?? null,
        input.category ?? null,
        input.google_maps ?? null,
        input.source ?? "manual",
        input.notes ?? null,
        input.deal_value ?? null,
        input.next_action ?? null,
        input.next_action_at ?? null,
        input.linkedin ?? null,
        input.twitter ?? null,
        input.facebook ?? null,
        input.instagram ?? null,
        input.company ?? null,
        input.priority_tier ?? null,
        input.tier ?? null,
        input.tier_label ?? null,
        input.risk_level ?? null,
        input.risk_score ?? null,
        input.risk_notes ?? null,
        input.tech_stack ?? null,
        input.revenue_estimate ?? null,
        input.employee_count ?? null,
        input.language ?? "en",
        input.offer_track ?? null,
        input.offer_rationale ?? null,
        input.pain_category ?? null,
        input.playbook_id ?? null,
        input.enrichment_json ?? null,
        input.enrichment_version ?? null,
        input.enriched_at ?? null,
        input.outreach_route ?? null,
        input.contact_name ?? null,
        input.pec_email ?? null,
        now,
        now,
      ],
    )
  const client = row<Client>("SELECT * FROM clients WHERE id = ?", [result.lastInsertRowid])
  if (!client) throw new Error("Client insert did not produce a row.")
  return { client, created: true }
}

export interface ClientQuery {
  query?: string
  status?: string
  limit?: number
  offset?: number
  sort?: string
  dir?: "asc" | "desc"
  pipeline?: boolean
  all?: boolean
}

/** Find clients by name/vertical/website text and/or exact status, newest first. */
const SORTABLE = new Set(["name", "email", "phone", "score", "source", "status", "company", "deal_value", "created_at", "updated_at"])

export function findClients(query: ClientQuery = {}): Client[] {
  const all = query.all === true
  const limit = all ? undefined : Math.max(1, Math.min(200, query.limit ?? 50))
  const offset = all ? 0 : Math.max(0, query.offset ?? 0)
  const filters: string[] = []
  const params: unknown[] = []
  if (query.status) {
    filters.push("status = ?")
    params.push(assertStatus(query.status))
  }
  if (query.pipeline) {
    filters.push("status != 'scouted'")
  }
  const text = query.query?.trim()
  if (text) {
    const like = `%${text}%`
    filters.push("(name LIKE ? OR vertical LIKE ? OR website LIKE ? OR notes LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ?)")
    params.push(like, like, like, like, like, like, like)
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""
  const sortCol = SORTABLE.has(query.sort ?? "") ? (query.sort as string) : "updated_at"
  const dir = query.dir === "asc" ? "ASC" : "DESC"
  if (all) {
    return rows<Client>(`SELECT * FROM clients ${where} ORDER BY ${sortCol} ${dir}`, params)
  }
  return rows<Client>(`SELECT * FROM clients ${where} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`, [
    ...params,
    limit as number,
    offset,
  ])
}

export function countClients(query: ClientQuery = {}): number {
  const filters: string[] = []
  const params: unknown[] = []
  if (query.status) {
    filters.push("status = ?")
    params.push(assertStatus(query.status))
  }
  if (query.pipeline) {
    filters.push("status != 'scouted'")
  }
  const text = query.query?.trim()
  if (text) {
    const like = `%${text}%`
    filters.push("(name LIKE ? OR vertical LIKE ? OR website LIKE ? OR notes LIKE ?)")
    params.push(like, like, like, like)
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""
  const r = crmDb().query(`SELECT COUNT(*) as c FROM clients ${where}`).get(...(params as any)) as { c: number }
  return r.c
}

export function listCompanies(): { name: string; count: number }[] {
  const rows = crmDb()
    .query("SELECT company, COUNT(*) as c FROM clients WHERE company IS NOT NULL AND company != '' GROUP BY company ORDER BY c DESC, company ASC")
    .all() as { company: string; c: number }[]
  return rows.map((r) => ({ name: r.company, count: r.c }))
}

export interface SegmentFilter {
  status?: string
  min_score?: number
  max_score?: number
  tags?: string[]
  source_contains?: string
  query?: string
  priority?: string
  company_contains?: string
  has_email?: boolean
  has_phone?: boolean
  has_website?: boolean
  tier?: number
}

export interface Segment {
  id: number
  name: string
  description: string | null
  filter: SegmentFilter
  created_at: string
  updated_at: string
}

function buildSegmentWhere(f: SegmentFilter): { sql: string; params: any[] } {
  const filters: string[] = []
  const params: any[] = []
  if (f.status) { filters.push("status = ?"); params.push(f.status) }
  if (typeof f.min_score === "number") { filters.push("score >= ?"); params.push(f.min_score) }
  if (typeof f.max_score === "number") { filters.push("score <= ?"); params.push(f.max_score) }
  if (f.source_contains) { filters.push("source LIKE ?"); params.push("%" + f.source_contains + "%") }
  if (f.query) { const like = "%" + f.query + "%"; filters.push("(name LIKE ? OR email LIKE ? OR notes LIKE ? OR company LIKE ?)"); params.push(like, like, like, like) }
  if (f.priority) { filters.push("priority_tier = ?"); params.push(f.priority) }
  if (f.company_contains) { filters.push("company LIKE ?"); params.push("%" + f.company_contains + "%") }
  if (f.has_email) { filters.push("email IS NOT NULL AND email != ''") }
  if (f.has_phone) { filters.push("phone IS NOT NULL AND phone != ''") }
  if (f.has_website) { filters.push("website IS NOT NULL AND website != ''") }
  if (typeof f.tier === "number") { filters.push("tier = ?"); params.push(f.tier) }
  if (f.tags && f.tags.length) {
    // clients having any of these tags
    const placeholders = f.tags.map(() => "?").join(",")
    filters.push("id IN (SELECT ct.client_id FROM client_tags ct JOIN tags t ON t.id=ct.tag_id WHERE t.name IN (" + placeholders + "))")
    params.push(...f.tags)
  }
  const where = filters.length ? "WHERE " + filters.join(" AND ") : ""
  return { sql: where, params }
}

export function saveSegment(name: string, description: string | null, filter: SegmentFilter): number {
  const now = new Date().toISOString()
  const r = crmDb().run(
    "INSERT INTO segments (name, description, filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [name, description, JSON.stringify(filter || {}), now, now],
  )
  return Number(r.lastInsertRowid)
}

export function updateSegment(id: number, name: string, description: string | null, filter: SegmentFilter): void {
  const now = new Date().toISOString()
  crmDb().run(
    "UPDATE segments SET name = ?, description = ?, filter = ?, updated_at = ? WHERE id = ?",
    [name, description, JSON.stringify(filter || {}), now, id],
  )
}

export function deleteSegment(id: number): void {
  crmDb().run("DELETE FROM segments WHERE id = ?", [id])
}

export function getSegment(id: number): Segment | null {
  const r = crmDb().query("SELECT id, name, description, filter, created_at, updated_at FROM segments WHERE id = ?").get(id) as any
  if (!r) return null
  let filter: SegmentFilter = {}
  try { filter = JSON.parse(r.filter) } catch {}
  return { id: r.id, name: r.name, description: r.description, filter, created_at: r.created_at, updated_at: r.updated_at }
}

export function listSegments(): Segment[] {
  const rows = crmDb().query("SELECT id, name, description, filter, created_at, updated_at FROM segments ORDER BY updated_at DESC").all() as any[]
  return rows.map((r) => {
    let filter: SegmentFilter = {}
    try { filter = JSON.parse(r.filter) } catch {}
    return { id: r.id, name: r.name, description: r.description, filter, created_at: r.created_at, updated_at: r.updated_at }
  })
}

export function countSegmentMembers(filter: SegmentFilter): number {
  const { sql, params } = buildSegmentWhere(filter || {})
  const r = crmDb().query("SELECT COUNT(*) as c FROM clients " + sql).get(...(params as any)) as { c: number }
  return r.c
}

export function listSegmentMembers(filter: SegmentFilter, limit = 100, offset = 0): any[] {
  const { sql, params } = buildSegmentWhere(filter || {})
  return crmDb().query("SELECT * FROM clients " + sql + " ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(...(params as any), limit, offset) as any[]
}

export interface ScoutRun {
  id: number
  location: string
  query: string
  limit_n: number | null
  sources: string[]
  results: any[]
  created_at: string
}

export function saveScoutRun(location: string, query: string, limitN: number, sources: string[], results: any[]): number {
  const r = crmDb().run(
    "INSERT INTO scout_runs (location, query, limit_n, sources, results, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [location, query, limitN, JSON.stringify(sources), JSON.stringify(results), new Date().toISOString()],
  )
  return Number(r.lastInsertRowid)
}

export function listScoutRuns(): { id: number; location: string; query: string; count: number; sources: string[]; created_at: string }[] {
  const rows = crmDb().query("SELECT id, location, query, limit_n, sources, results, created_at FROM scout_runs ORDER BY created_at DESC LIMIT 50").all() as any[]
  return rows.map((r) => {
    let results: any[] = []
    try { results = JSON.parse(r.results) } catch {}
    let sources: string[] = []
    try { sources = JSON.parse(r.sources) } catch {}
    return { id: r.id, location: r.location, query: r.query, count: results.length, sources, created_at: r.created_at }
  })
}

export function getScoutRun(id: number): ScoutRun | null {
  const r = crmDb().query("SELECT id, location, query, limit_n, sources, results, created_at FROM scout_runs WHERE id = ?").get(id) as any
  if (!r) return null
  let results: any[] = []
  try { results = JSON.parse(r.results) } catch {}
  let sources: string[] = []
  try { sources = JSON.parse(r.sources) } catch {}
  return { id: r.id, location: r.location, query: r.query, limit_n: r.limit_n, sources, results, created_at: r.created_at }
}

export function deleteScoutRun(id: number): void {
  crmDb().run("DELETE FROM scout_runs WHERE id = ?", [id])
}

export function getClient(id: number): Client | null {
  return row<Client>("SELECT * FROM clients WHERE id = ?", [id]) ?? null
}

const UPDATABLE = [
  "name",
  "vertical",
  "status",
  "score",
  "address",
  "phone",
  "website",
  "email",
  "notes",
  "deal_value",
  "next_action",
  "next_action_at",
  "last_contact",
  "source",
  "linkedin",
  "twitter",
  "facebook",
  "instagram",
  "company",
  "priority_tier",
  "tier",
  "tier_label",
  "risk_level",
  "risk_score",
  "risk_notes",
  "tech_stack",
  "revenue_estimate",
  "employee_count",
  "language",
  "offer_track",
  "offer_rationale",
  "pain_category",
  "playbook_id",
  "enrichment_json",
  "enrichment_version",
  "enriched_at",
  "outreach_route",
  "contact_name",
  "pec_email",
] as const

export type ClientPatch = Partial<Record<(typeof UPDATABLE)[number], string | number | null>>

/** Patch a client. Returns the fresh row, or null when the id does not exist. */
export function updateClient(id: number, patch: ClientPatch): Client | null {
  const client = getClient(id)
  if (!client) return null

  const fields: string[] = []
  const params: (string | number | null)[] = []
  for (const key of UPDATABLE) {
    if (!(key in patch)) continue
    if (key === "status") assertStatus(String(patch[key]))
    fields.push(`${key} = ?`)
    params.push(patch[key] ?? null)
  }
  if (patch.status) {
    ensureStageExists(String(patch.status))
  }
  if (!fields.length) return client
  fields.push("updated_at = ?")
  params.push(nowISO(), id)
  crmDb().run(`UPDATE clients SET ${fields.join(", ")} WHERE id = ?`, params)
  logAudit("client", id, "updated", JSON.stringify(patch))

  // Reply / opt-out guard: cancel follow-up cadence for terminal statuses.
  const terminalStatuses = new Set(["replied", "booked", "won", "lost", "opted_out", "yes", "no", "stale", "done"])
  if (patch.status && terminalStatuses.has(String(patch.status))) {
    try {
      crmDb().run("UPDATE pipeline SET next_touch_at = NULL, queued_touch = 0, updated_at = ? WHERE client_id = ?", [nowISO(), id])
      // cancel unapproved follow-up drafts
      crmDb().run("UPDATE pipeline SET draft_path = NULL WHERE client_id = ? AND approved = 0", [id])
    } catch { /* best effort */ }
  }
  return getClient(id)
}

export function deleteClient(id: number): boolean {
  const client = getClient(id)
  if (!client) return false
  const db = crmDb()
  for (const table of ["client_interactions", "client_assets", "deals", "client_tags"]) {
    try { db.run(`DELETE FROM ${table} WHERE client_id = ?`, [id]) } catch { /* table may not exist */ }
  }
  db.run("DELETE FROM clients WHERE id = ?", [id])
  try { logAudit("client", id, "deleted", JSON.stringify({ name: client.name })) } catch { /* best effort */ }
  return true
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

/**
 * Record one touch or reply. Every interaction also moves the client's
 * `last_contact`, because the follow-up cadence (Task E) works off that
 * single column.
 */
export function logInteraction(clientId: number, input: InteractionInput): Interaction {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const occurredAt = input.occurred_at ?? nowISO()
  const result = crmDb()
    .run(
      `INSERT INTO client_interactions (
         client_id, kind, direction, channel, status, subject, body, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId,
        input.kind,
        input.direction ?? null,
        input.channel ?? null,
        input.status ?? null,
        input.subject ?? null,
        input.body ?? null,
        occurredAt,
        nowISO(),
      ],
    )
  crmDb().run("UPDATE clients SET last_contact = ?, updated_at = ? WHERE id = ?", [
    occurredAt,
    nowISO(),
    clientId,
  ])
  const interaction = row<Interaction>("SELECT * FROM client_interactions WHERE id = ?", [
    result.lastInsertRowid,
  ])
  if (!interaction) throw new Error("Interaction insert did not produce a row.")
  return interaction
}

export function listInteractions(clientId: number): Interaction[] {
  return rows<Interaction>(
    "SELECT * FROM client_interactions WHERE client_id = ? ORDER BY occurred_at DESC, id DESC",
    [clientId],
  )
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export function findClientByEmail(email: string | null | undefined): Client | null {
  if (!email) return null
  const e = String(email).trim().toLowerCase()
  if (!e || !e.includes("@")) return null
  const found = crmDb().query("SELECT * FROM clients WHERE LOWER(email) = ? LIMIT 1").get(e) as Client | undefined
  if (found) return found
  // Strict domain fallback: only match when a client's website hostname
  // exactly equals the email's domain (B2B: hello@acme.com -> acme.com site).
  const domain = e.split("@")[1]
  if (!domain) return null
  const clients = crmDb().query("SELECT * FROM clients WHERE website IS NOT NULL AND website != ''").all() as Client[]
  for (const c of clients) {
    try {
      const u = new URL((c.website || "").includes("://") ? (c.website as string) : "https://" + (c.website as string))
      if (u.hostname.toLowerCase() === domain || u.hostname.toLowerCase() === "www." + domain) return c
    } catch { /* ignore */ }
  }
  return null
}

export function listEmails(filter: { folder?: string; q?: string; client_id?: number; limit?: number } = {}): Email[] {
  const limit = Math.max(1, Math.min(500, filter.limit ?? 100))
  const where: string[] = []
  const params: unknown[] = []
  if (filter.folder) { where.push("folder = ?"); params.push(filter.folder) }
  if (filter.client_id) { where.push("client_id = ?"); params.push(filter.client_id) }
  if (filter.q) {
    const like = "%" + filter.q + "%"
    where.push("(subject LIKE ? OR body LIKE ? OR from_addr LIKE ? OR to_addr LIKE ? OR cc LIKE ?)")
    params.push(like, like, like, like, like)
  }
  const sql = "SELECT * FROM emails" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY occurred_at DESC, id DESC LIMIT ?"
  params.push(limit)
  return rows<Email>(sql, params)
}

export function getEmail(id: number): Email | null {
  return (crmDb().query("SELECT * FROM emails WHERE id = ?").get(id) as Email | undefined) ?? null
}

export function createEmail(input: EmailInput): Email {
  const now = nowISO()
  const occurredAt = input.occurred_at ?? now
  const result = crmDb().run(
    `INSERT INTO emails (folder, direction, from_addr, to_addr, cc, bcc, subject, body, html, occurred_at, created_at, updated_at, client_id, company, thread_id, is_read, is_starred, labels, resend_id, gmail_id, provider, in_reply_to, has_attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.folder ?? "drafts",
      input.direction ?? "out",
      input.from_addr ?? null,
      input.to_addr ?? null,
      input.cc ?? null,
      input.bcc ?? null,
      input.subject ?? null,
      input.body ?? null,
      input.html ?? null,
      occurredAt,
      now,
      now,
      input.client_id ?? null,
      input.company ?? null,
      input.thread_id ?? null,
      input.is_read ?? 0,
      input.is_starred ?? 0,
      input.labels ?? null,
      input.resend_id ?? null,
      input.gmail_id ?? null,
      input.provider ?? "local",
      input.in_reply_to ?? null,
      input.has_attachments ?? 0,
    ],
  )
  const email = getEmail(Number(result.lastInsertRowid))
  if (!email) throw new Error("Email insert did not produce a row.")
  return email
}

export function updateEmail(id: number, patch: Partial<EmailInput> & { folder?: string; is_read?: number; is_starred?: number }): Email | null {
  const existing = getEmail(id)
  if (!existing) return null
  const now = nowISO()
  const fields: string[] = []
  const params: unknown[] = []
  const map: Record<string, unknown> = {
    folder: patch.folder,
    direction: patch.direction,
    from_addr: patch.from_addr,
    to_addr: patch.to_addr,
    cc: patch.cc,
    bcc: patch.bcc,
    subject: patch.subject,
    body: patch.body,
    html: patch.html,
    occurred_at: patch.occurred_at,
    client_id: patch.client_id,
    company: patch.company,
    thread_id: patch.thread_id,
    is_read: patch.is_read,
    is_starred: patch.is_starred,
    labels: patch.labels,
    resend_id: patch.resend_id,
    gmail_id: patch.gmail_id,
    provider: patch.provider,
    in_reply_to: patch.in_reply_to,
    has_attachments: patch.has_attachments,
  }
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) { fields.push(`${k} = ?`); params.push(v) }
  }
  if (fields.length === 0) return existing
  fields.push("updated_at = ?")
  params.push(now)
  params.push(id)
  crmDb().run(`UPDATE emails SET ${fields.join(", ")} WHERE id = ?`, params as any)
  return getEmail(id)
}

export function deleteEmail(id: number): void {
  crmDb().run("DELETE FROM emails WHERE id = ?", [id])
}

export function moveEmail(id: number, folder: string): Email | null {
  return updateEmail(id, { folder })
}

export function emailCounts(): Record<string, number> {
  const rows = crmDb().query("SELECT folder, COUNT(*) as c FROM emails GROUP BY folder").all() as { folder: string; c: number }[]
  const out: Record<string, number> = { inbox: 0, sent: 0, drafts: 0, trash: 0, starred: 0, all: 0 }
  let total = 0
  for (const r of rows) { out[r.folder] = (out[r.folder] ?? 0) + r.c; total += r.c }
  out.all = total
  const starred = crmDb().query("SELECT COUNT(*) as c FROM emails WHERE is_starred = 1 AND folder != 'trash'").get() as { c: number }
  out.starred = starred?.c ?? 0
  const unread = crmDb().query("SELECT COUNT(*) as c FROM emails WHERE folder = 'inbox' AND is_read = 0").get() as { c: number }
  out.unread = unread?.c ?? 0
  return out
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Attach a document or artifact to a client (proposal, workbook, SOP, invoice). */
export function addAsset(clientId: number, input: AssetInput): ClientAsset {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const result = crmDb().run(
    `INSERT INTO client_assets (client_id, kind, name, path, status, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [clientId, input.kind, input.name, input.path ?? null, input.status ?? null, input.notes ?? null, nowISO()],
  )
  const asset = row<ClientAsset>("SELECT * FROM client_assets WHERE id = ?", [result.lastInsertRowid])
  if (!asset) throw new Error("Asset insert did not produce a row.")
  return asset
}

export function listAssets(clientId: number): ClientAsset[] {
  return rows<ClientAsset>("SELECT * FROM client_assets WHERE client_id = ? ORDER BY id DESC", [
    clientId,
  ])
}

// One-time migration disabled: it clobbered manual status changes
// (e.g. demoting an enriched lead back to scouted). Run manually if needed.
// try { migrateEnrichedLeads() } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Configured pipeline stages (from ~/.ai-enablement-agent/pipeline-stages.json, else defaults)
// ---------------------------------------------------------------------------
export function configuredStageIds(): string[] {
  try {
    const fs = require("node:fs")
    const path = require("node:path")
    const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || ((process.env.HOME || "") + "/.ai-enablement-agent")
    const file = path.join(home, "pipeline-stages.json")
    if (fs.existsSync(file)) {
      const stages = JSON.parse(fs.readFileSync(file, "utf8"))
      if (Array.isArray(stages) && stages.length) return stages.map((s: any) => String(s.id))
    }
  } catch { /* fall through */ }
  return ["scouted", "manual_check", "draft_ready", "contacted", "followup_1", "followup_2", "followup_3", "yes", "no", "stale", "diagnose", "proposal", "workbook", "scheduled", "payment", "done"]
}

export function stageExists(id: string): boolean {
  return configuredStageIds().includes(id)
}

export function ensureStageExists(id: string): void {
  if (!id || !id.trim()) return
  if (stageExists(id)) return
  try {
    const fs = require("node:fs")
    const path = require("node:path")
    const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || ((process.env.HOME || "") + "/.ai-enablement-agent")
    const file = path.join(home, "pipeline-stages.json")
    let stages: any[] = []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
      if (Array.isArray(parsed)) stages = parsed
    } catch { /* no file or invalid */ }
    if (!stages.some((s: any) => String(s?.id) === id)) {
      stages.push({ id, label: id, color: "#62666d", statusColor: "muted" })
      fs.writeFileSync(file, JSON.stringify(stages, null, 2), { mode: 0o600 })
    }
  } catch { /* best effort */ }
}

export function firstConfiguredStage(): string {
  const ids = configuredStageIds()
  return ids.length ? ids[0] : "scouted"
}

// One-time migration: any client that has an enrichment asset (diagnosis.md /
// proposal.md) or an enrichment interaction but is still in a "first stage"
// gets moved to "enriched", so enriched leads are discoverable by status.
export function migrateEnrichedLeads(): void {
  try {
    const clients = rows<{ id: number; status: string }>("SELECT id, status FROM clients", [])
    for (const c of clients) {
      const first = firstConfiguredStage()
      if (c.status !== first && c.status !== "scouted" && c.status !== "new" && c.status !== "" && c.status !== null) continue
      const assets = rows<{ kind: string; name: string }>(
        "SELECT kind, name FROM client_assets WHERE client_id = ?",
        [c.id],
      )
      const hasEnrichmentAsset = assets.some(
        (a) => a.kind === "enrichment" || (a.name ?? "").toLowerCase().includes("diagnosis") || (a.name ?? "").toLowerCase().includes("proposal"),
      )
      const interactions = rows<{ kind: string }>(
        "SELECT kind FROM client_interactions WHERE client_id = ?",
        [c.id],
      )
      const hasEnrichmentInteraction = interactions.some((i) => (i.kind ?? "").toLowerCase().includes("enrich"))
      if (hasEnrichmentAsset || hasEnrichmentInteraction) {
        crmDb().run("UPDATE clients SET status = 'enriched', updated_at = ? WHERE id = ?", [
          new Date().toISOString(),
          c.id,
        ])
      }
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Triggered email engine
// ---------------------------------------------------------------------------

export interface EmailTrigger {
  id: number
  client_id: number
  name: string
  event: string
  subject: string
  body: string
  status: string
  cooldown_days: number
  created_at: string
  fired_at: string | null
}

export interface TriggerInput {
  name: string
  event: string
  subject: string
  body: string
  cooldown_days?: number
}

export function addTrigger(clientId: number, input: TriggerInput): EmailTrigger {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  // Deduplicate by (client_id, name): if a trigger with the same name already
  // exists for this client, return the existing row instead of inserting.
  const existing = crmDb().query("SELECT * FROM email_triggers WHERE client_id = ? AND name = ?").get(clientId, input.name) as EmailTrigger | undefined
  if (existing) return existing
  const result = crmDb().run(
    `INSERT INTO email_triggers (client_id, name, event, subject, body, status, cooldown_days, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [clientId, input.name, input.event, input.subject, input.body, input.cooldown_days ?? 0, nowISO()],
  )
  const t = crmDb().query("SELECT * FROM email_triggers WHERE id = ?").get(result.lastInsertRowid) as EmailTrigger
  return t
}

export function listTriggers(clientId?: number): EmailTrigger[] {
  if (clientId) return crmDb().query("SELECT * FROM email_triggers WHERE client_id = ? ORDER BY id DESC").all(clientId) as EmailTrigger[]
  return crmDb().query("SELECT * FROM email_triggers ORDER BY id DESC").all() as EmailTrigger[]
}

export function setTriggerStatus(id: number, status: string): void {
  crmDb().run("UPDATE email_triggers SET status = ? WHERE id = ?", [status, id])
}

export function deleteTrigger(id: number): void {
  crmDb().run("DELETE FROM email_triggers WHERE id = ?", [id])
}

/**
 * Evaluate active triggers. A trigger fires when its event condition holds
 * and it is not within its cooldown. Fired triggers write a draft file into
 * the pipeline folder for human approval (nothing is sent automatically)
 * and are marked 'fired'.
 *
 * Supported events:
 *   - stage_is:<status>            fires once when client reaches that status
 *   - days_in_stage:<status>:<n>   fires when client has been in status >= n days
 *   - days_after_handover:<n>      fires n days after a handover asset exists
 */
export function processTriggers(): { fired: number; checked: number } {
  const triggers = crmDb().query("SELECT * FROM email_triggers WHERE status = 'active'").all() as EmailTrigger[]
  let fired = 0
  for (const t of triggers) {
    const client = getClient(t.client_id)
    if (!client) continue
    let shouldFire = false
    const event = t.event.trim()
    if (event.startsWith("stage_is:")) {
      const target = event.slice("stage_is:".length)
      shouldFire = client.status === target && (!t.fired_at)
    } else if (event.startsWith("days_in_stage:")) {
      const parts = event.slice("days_in_stage:".length).split(":")
      const targetStatus = parts[0]
      const days = Number(parts[1] ?? "0")
      if (client.status === targetStatus) {
        const updated = new Date(client.updated_at).getTime()
        const ageDays = (Date.now() - updated) / 86400000
        shouldFire = ageDays >= days
      }
    } else if (event.startsWith("days_after_handover:")) {
      const days = Number(event.slice("days_after_handover:".length))
      const assets = listAssets(t.client_id).filter((a) => a.kind === "handover" || (a.name ?? "").toLowerCase().includes("handover"))
      if (assets.length) {
        const created = new Date(assets[0].created_at).getTime()
        const ageDays = (Date.now() - created) / 86400000
        shouldFire = ageDays >= days
      }
    }
    // Cooldown check.
    if (shouldFire && t.fired_at && t.cooldown_days > 0) {
      const lastFired = new Date(t.fired_at).getTime()
      if ((Date.now() - lastFired) / 86400000 < t.cooldown_days) shouldFire = false
    }
    if (!shouldFire) continue

    // Write a draft file for human approval.
    try {
      const dir = path.join((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) ?? _AI_ENABLEMENT_HOME, "pipeline", nowISO().slice(0, 10))
      fs.mkdirSync(dir, { recursive: true })
      const vars: Record<string, string> = { CLIENT_NAME: client.name, CONTACT_NAME: client.name, EMAIL: client.email ?? "" }
      let subject = t.subject
      let body = t.body
      for (const [k, v] of Object.entries(vars)) {
        subject = subject.split(`{{${k}}}`).join(v)
        body = body.split(`{{${k}}}`).join(v)
      }
      const file = path.join(dir, `trigger-${t.id}-${client.id}.md`)
      fs.writeFileSync(file, `# Triggered email: ${t.name}\n\nTo: ${client.email ?? "(no email)"}\nSubject: ${subject}\n\n${body}\n\n---\nTrigger event: ${t.event}\nClient: ${client.name} (#${client.id})\n`, { mode: 0o644 })
    } catch {
      // Best effort.
    }
    crmDb().run("UPDATE email_triggers SET status = 'fired', fired_at = ? WHERE id = ?", [nowISO(), t.id])
    fired++
  }
  return { fired, checked: triggers.length }
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export function setCustomField(clientId: number, key: string, value: string): void {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  crmDb().run(
    `INSERT INTO client_custom_fields (client_id, key, value, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(client_id, key) DO UPDATE SET value = excluded.value`,
    [clientId, key, value, nowISO()],
  )
}

export function getCustomFields(clientId: number): Record<string, string> {
  const rows = crmDb().query("SELECT key, value FROM client_custom_fields WHERE client_id = ?").all(clientId) as { key: string; value: string | null }[]
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.value ?? ""
  return out
}

export function deleteCustomField(clientId: number, key: string): void {
  crmDb().run("DELETE FROM client_custom_fields WHERE client_id = ? AND key = ?", [clientId, key])
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export interface Deal {
  id: number
  client_id: number
  title: string
  stage: string
  value: number | null
  currency: string
  probability: number | null
  close_date: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface DealInput {
  title: string
  stage?: string
  value?: number
  currency?: string
  probability?: number
  close_date?: string
  notes?: string
}

export function addDeal(clientId: number, input: DealInput): Deal {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const result = crmDb().run(
    `INSERT INTO deals (client_id, title, stage, value, currency, probability, close_date, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [clientId, input.title, input.stage ?? "open", input.value ?? null, input.currency ?? "EUR", input.probability ?? null, input.close_date ?? null, input.notes ?? null, nowISO(), nowISO()],
  )
  const deal = crmDb().query("SELECT * FROM deals WHERE id = ?").get(result.lastInsertRowid) as Deal
  logAudit("deal", deal.id, "created", JSON.stringify(input))
  return deal
}

export function updateDeal(id: number, patch: Partial<DealInput> & { stage?: string }): Deal | null {
  const existing = crmDb().query("SELECT * FROM deals WHERE id = ?").get(id) as Deal | null
  if (!existing) return null
  const fields: string[] = []
  const vals: unknown[] = []
  if (patch.title !== undefined) { fields.push("title = ?"); vals.push(patch.title) }
  if (patch.stage !== undefined) { fields.push("stage = ?"); vals.push(patch.stage) }
  if (patch.value !== undefined) { fields.push("value = ?"); vals.push(patch.value) }
  if (patch.currency !== undefined) { fields.push("currency = ?"); vals.push(patch.currency) }
  if (patch.probability !== undefined) { fields.push("probability = ?"); vals.push(patch.probability) }
  if (patch.close_date !== undefined) { fields.push("close_date = ?"); vals.push(patch.close_date) }
  if (patch.notes !== undefined) { fields.push("notes = ?"); vals.push(patch.notes) }
  if (!fields.length) return existing
  fields.push("updated_at = ?")
  vals.push(nowISO())
  vals.push(id)
  crmDb().run(`UPDATE deals SET ${fields.join(", ")} WHERE id = ?`, vals as never[])
  logAudit("deal", id, "updated", JSON.stringify(patch))
  return crmDb().query("SELECT * FROM deals WHERE id = ?").get(id) as Deal
}

export function listDeals(clientId?: number): Deal[] {
  if (clientId) return crmDb().query("SELECT * FROM deals WHERE client_id = ? ORDER BY id DESC").all(clientId) as Deal[]
  return crmDb().query("SELECT * FROM deals ORDER BY id DESC").all() as Deal[]
}

export function deleteDeal(id: number): void {
  crmDb().run("DELETE FROM deals WHERE id = ?", [id])
  logAudit("deal", id, "deleted", null)
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function addTag(clientId: number, name: string): void {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  crmDb().run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [name])
  const tag = crmDb().query("SELECT id FROM tags WHERE name = ?").get(name) as { id: number }
  crmDb().run("INSERT OR IGNORE INTO client_tags (client_id, tag_id) VALUES (?, ?)", [clientId, tag.id])
}

export function removeTag(clientId: number, name: string): void {
  const tag = crmDb().query("SELECT id FROM tags WHERE name = ?").get(name) as { id: number } | null
  if (!tag) return
  crmDb().run("DELETE FROM client_tags WHERE client_id = ? AND tag_id = ?", [clientId, tag.id])
}

export function listTags(clientId: number): string[] {
  const rows = crmDb().query(
    "SELECT t.name FROM tags t JOIN client_tags ct ON ct.tag_id = t.id WHERE ct.client_id = ? ORDER BY t.name",
  ).all(clientId) as { name: string }[]
  return rows.map((r) => r.name)
}

export function allTags(): string[] {
  const rows = crmDb().query("SELECT name FROM tags ORDER BY name").all() as { name: string }[]
  return rows.map((r) => r.name)
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function logAudit(entity: string, entityId: number | null, action: string, diff: string | null, actor = "elitza"): void {
  crmDb().run(
    "INSERT INTO audit_log (entity, entity_id, action, diff, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [entity, entityId, action, diff, actor, nowISO()],
  )
}

export function listAudit(entity?: string, entityId?: number, limit = 50): { id: number; entity: string; entity_id: number | null; action: string; diff: string | null; actor: string; created_at: string }[] {
  if (entity && entityId !== undefined) {
    return crmDb().query("SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?").all(entity, entityId, limit) as any
  }
  if (entity) {
    return crmDb().query("SELECT * FROM audit_log WHERE entity = ? ORDER BY id DESC LIMIT ?").all(entity, limit) as any
  }
  return crmDb().query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as any
}


export function logTurnCost(sessionId: string, inputTokens: number, outputTokens: number, costUsd: number): void {
  crmDb().run(
    "INSERT INTO turn_costs (session_id, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    [sessionId, inputTokens, outputTokens, costUsd, nowISO()],
  )
}

export function costSummary(days = 7): { sessions: number; input_tokens: number; output_tokens: number; cost_usd: number } {
  const since = new Date(Date.now() - days*86400000).toISOString()
  const row = crmDb().query(
    "SELECT COUNT(*) AS sessions, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd FROM turn_costs WHERE created_at >= ?"
  ).get(since) as any
  return { sessions: row.sessions, input_tokens: row.input_tokens, output_tokens: row.output_tokens, cost_usd: row.cost_usd }
}

// ---------------------------------------------------------------------------
// CSV import / export
// ---------------------------------------------------------------------------

export function exportClientsCSV(): string {
  const clients = findClients({ limit: 10000 })
  const cols = ["id", "name", "vertical", "status", "score", "email", "phone", "website", "address", "deal_value", "source", "created_at"]
  const lines = [cols.join(",")]
  for (const c of clients) {
    lines.push(cols.map((col) => {
      const v = (c as any)[col]
      const s = v === null || v === undefined ? "" : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(","))
  }
  return lines.join("\n")
}

/** RFC-4180 CSV parser: returns array of rows, each row an array of fields. */
function parseCSV(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0
  const s = csv
  while (i < s.length) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ""; i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue }
    if (c === '\r') { i++; continue }
    field += c; i++
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

export function importClientsCSV(csv: string): { imported: number; skipped: number } {
  const parsed = parseCSV(csv.trim())
  if (parsed.length < 2) return { imported: 0, skipped: 0 }
  const header = parsed[0].map((h) => h.trim().toLowerCase())
  const nameIdx = header.indexOf("name")
  if (nameIdx < 0) return { imported: 0, skipped: parsed.length - 1 }
  let imported = 0, skipped = 0
  for (let i = 1; i < parsed.length; i++) {
    const cols = parsed[i]
    if (cols.every((c) => c.trim() === "")) { skipped++; continue }
    const name = (cols[nameIdx] ?? "").trim()
    if (!name) { skipped++; continue }
    const get = (k: string) => {
      const idx = header.indexOf(k)
      return idx >= 0 ? (cols[idx] ?? "").trim() : ""
    }
    addClient({
      name,
      vertical: get("vertical") || undefined,
      status: get("status") || undefined,
      score: get("score") ? Number(get("score")) : undefined,
      email: get("email") || undefined,
      phone: get("phone") || undefined,
      website: get("website") || undefined,
      address: get("address") || undefined,
      deal_value: get("deal_value") ? Number(get("deal_value")) : undefined,
      source: get("source") || "import",
    })
    imported++
  }
  return { imported, skipped }
}


// ---------------------------------------------------------------------------
// Cloud storage (Google Drive / Dropbox / OneDrive) continuous backup
// ---------------------------------------------------------------------------

export interface CloudAccount {
  id: number
  provider: string
  account_label: string | null
  access_token: string
  refresh_token: string | null
  folder_id: string | null
  status: string
  last_sync: string | null
  last_error: string | null
  created_at: string
}

export function connectCloud(provider: string, accessToken: string, refreshToken?: string, label?: string): CloudAccount {
  const result = crmDb().run(
    `INSERT INTO cloud_accounts (provider, account_label, access_token, refresh_token, status, created_at)
     VALUES (?, ?, ?, ?, 'connected', ?)`,
    [provider, label ?? provider, accessToken, refreshToken ?? null, nowISO()],
  )
  const acc = crmDb().query("SELECT * FROM cloud_accounts WHERE id = ?").get(result.lastInsertRowid) as CloudAccount
  logAudit("cloud", acc.id, "connected", provider)
  return acc
}

export function disconnectCloud(id: number): void {
  crmDb().run("DELETE FROM cloud_accounts WHERE id = ?", [id])
  logAudit("cloud", id, "disconnected", null)
}

export function listCloudAccounts(): CloudAccount[] {
  return crmDb().query("SELECT * FROM cloud_accounts ORDER BY id DESC").all() as CloudAccount[]
}

export function getCloudAccount(id: number): CloudAccount | null {
  return (crmDb().query("SELECT * FROM cloud_accounts WHERE id = ?").get(id) as CloudAccount) ?? null
}

export function updateCloudSync(id: number, ok: boolean, error?: string): void {
  if (ok) crmDb().run("UPDATE cloud_accounts SET last_sync = ?, last_error = NULL, status = 'connected' WHERE id = ?", [nowISO(), id])
  else crmDb().run("UPDATE cloud_accounts SET last_error = ?, status = 'error' WHERE id = ?", [error ?? "unknown", id])
}

/**
 * Upload a backup tar.gz to a connected cloud account. Returns true on success.
 * Providers: google (Drive), dropbox, onedrive.
 */
export async function uploadBackupToCloud(accountId: number, filePath: string): Promise<{ ok: boolean; error?: string }> {
  const acc = getCloudAccount(accountId)
  if (!acc) return { ok: false, error: "account not found" }
  const fs = await import("node:fs")
  const path = await import("node:path")
  const data = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)
  try {
    if (acc.provider === "dropbox") {
      const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + acc.access_token,
          "Dropbox-API-Arg": JSON.stringify({ path: "/" + fileName, mode: "overwrite", autorename: false }),
          "Content-Type": "application/octet-stream",
        },
        body: data,
      })
      if (!r.ok) return { ok: false, error: "dropbox " + r.status + " " + await r.text() }
    } else if (acc.provider === "google" || acc.provider === "gdrive") {
      // Resumable simple upload
      const meta = JSON.stringify({ name: fileName })
      const boundary = "elitza_boundary_" + Date.now()
      const body = Buffer.concat([
        Buffer.from("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n"),
        Buffer.from("--" + boundary + "\r\nContent-Type: application/gzip\r\n\r\n"),
        data,
        Buffer.from("\r\n--" + boundary + "--"),
      ])
      const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: { "Authorization": "Bearer " + acc.access_token, "Content-Type": "multipart/related; boundary=" + boundary },
        body,
      })
      if (!r.ok) return { ok: false, error: "google " + r.status + " " + await r.text() }
    } else if (acc.provider === "onedrive") {
      const r = await fetch("https://graph.microsoft.com/v1.0/me/drive/root:/" + encodeURIComponent(fileName) + ":/content", {
        method: "PUT",
        headers: { "Authorization": "Bearer " + acc.access_token, "Content-Type": "application/gzip" },
        body: data,
      })
      if (!r.ok) return { ok: false, error: "onedrive " + r.status + " " + await r.text() }
    } else {
      return { ok: false, error: "unknown provider " + acc.provider }
    }
    updateCloudSync(accountId, true)
    logAudit("cloud", accountId, "backup_uploaded", fileName)
    return { ok: true }
  } catch (e) {
    updateCloudSync(accountId, false, String(e))
    return { ok: false, error: String(e) }
  }
}

/**
 * Continuous backup stream: create a tar.gz and upload to all connected accounts.
 * Called by heartbeat. Returns summary.
 */
export async function continuousBackupStream(): Promise<{ created: string; uploaded: number; errors: string[] }> {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const os = await import("node:os")
  const { execSync } = await import("node:child_process")
  const home = process.env.HOME || os.homedir()
  const elitzaHome = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (home + "/.ai-enablement-agent")
  const out = path.join(home, "ai-enablement-backup-" + new Date().toISOString().slice(0, 10) + ".tar.gz")
  try {
    execSync("tar -czf " + out + " -C " + home + " .ai-enablement-agent", { stdio: "pipe" })
  } catch (e) {
    return { created: "", uploaded: 0, errors: ["tar failed: " + String(e)] }
  }
  const accounts = listCloudAccounts().filter((a) => a.status === "connected")
  let uploaded = 0
  const errors: string[] = []
  for (const acc of accounts) {
    const r = await uploadBackupToCloud(acc.id, out)
    if (r.ok) uploaded++
    else errors.push(acc.provider + ": " + (r.error ?? "failed"))
  }
  return { created: out, uploaded, errors }
}

// ---------------------------------------------------------------------------
// Revenue dashboard aggregates
// ---------------------------------------------------------------------------

export function revenueStats(): {
  pipeline_value: number
  won_value: number
  open_deals: number
  won_deals: number
  clients_total: number
  clients_won: number
  conversion_rate: number
  by_status: { status: string; count: number; value: number }[]
  by_month: { month: string; value: number; count: number }[]
  avg_deal_value: number
  mrr_estimate: number
} {
  const clients = findClients({ limit: 10000 })
  const deals = listDeals()
  const byStatus = new Map<string, { count: number; value: number }>()
  for (const c of clients) {
    const cur = byStatus.get(c.status) ?? { count: 0, value: 0 }
    cur.count++
    cur.value += c.deal_value ?? 0
    byStatus.set(c.status, cur)
  }
  const byStatusArr = [...byStatus.entries()].map(([status, v]) => ({ status, count: v.count, value: v.value }))
  const wonStatuses = new Set(["done", "payment", "scheduled"])
  const wonClients = clients.filter((c) => wonStatuses.has(c.status))
  const wonValue = wonClients.reduce((s, c) => s + (c.deal_value ?? 0), 0) + deals.filter((d) => d.stage === "won" || d.stage === "closed").reduce((s, d) => s + (d.value ?? 0), 0)
  const pipelineValue = clients.filter((c) => !wonStatuses.has(c.status) && c.status !== "no" && c.status !== "stale").reduce((s, c) => s + (c.deal_value ?? 0), 0)
  const openDeals = deals.filter((d) => d.stage !== "won" && d.stage !== "closed" && d.stage !== "lost").length
  const wonDeals = deals.filter((d) => d.stage === "won" || d.stage === "closed").length
  // monthly aggregation by client created_at month for won clients
  const byMonthMap = new Map<string, { value: number; count: number }>()
  for (const c of wonClients) {
    const month = (c.created_at || "").slice(0, 7)
    if (!month) continue
    const cur = byMonthMap.get(month) ?? { value: 0, count: 0 }
    cur.value += c.deal_value ?? 0
    cur.count++
    byMonthMap.set(month, cur)
  }
  const byMonth = [...byMonthMap.entries()].sort().map(([month, v]) => ({ month, value: v.value, count: v.count }))
  const firstStage = firstConfiguredStage()
  const contacted = clients.filter((c) => c.status !== firstStage && c.status !== "scouted").length
  const conversionRate = clients.length ? wonClients.length / clients.length : 0
  const avgDealValue = wonClients.length ? Math.round(wonValue / wonClients.length) : 0
  // MRR estimate: recurring won deals (deal_value treated as one-time; estimate monthly as won/12 if no recurring flag)
  const mrrEstimate = Math.round(wonValue / 12)
  return {
    pipeline_value: pipelineValue,
    won_value: wonValue,
    open_deals: openDeals,
    won_deals: wonDeals,
    clients_total: clients.length,
    clients_won: wonClients.length,
    conversion_rate: conversionRate,
    by_status: byStatusArr,
    by_month: byMonth,
    avg_deal_value: avgDealValue,
    mrr_estimate: mrrEstimate,
  }
}

export function weeklyDigest(): string {
  const r = revenueStats()
  const due = findClients({ limit: 10000 }).filter((c) => c.next_action_at && c.next_action_at.slice(0, 10) <= new Date().toISOString().slice(0, 10))
  const lines: string[] = []
  lines.push("# Weekly Digest — " + new Date().toISOString().slice(0, 10))
  lines.push("")
  lines.push("## Revenue")
  lines.push(`- Pipeline value: EUR ${r.pipeline_value}`)
  lines.push(`- Won value: EUR ${r.won_value}`)
  lines.push(`- Conversion: ${(r.conversion_rate * 100).toFixed(1)}% (${r.clients_won}/${r.clients_total})`)
  lines.push(`- Avg deal: EUR ${r.avg_deal_value}`)
  lines.push(`- MRR estimate: EUR ${r.mrr_estimate}`)
  lines.push("")
  lines.push("## Pipeline by status")
  for (const s of r.by_status) lines.push(`- ${s.status}: ${s.count} (EUR ${s.value})`)
  lines.push("")
  lines.push("## Due this week")
  if (!due.length) lines.push("- Nothing due.")
  else for (const c of due) lines.push(`- ${c.name} (#${c.id}): ${c.next_action} (due ${c.next_action_at})`)
  lines.push("")
  lines.push("## Deals")
  lines.push(`- Open: ${r.open_deals}, Won: ${r.won_deals}`)
  return lines.join("\\n")
}

// ---------------------------------------------------------------------------
// Marketing — Email Campaigns, Ads, Content Calendar
// ---------------------------------------------------------------------------

export interface MktEmailCampaign {
  id: number; name: string; type: string; status: string;
  subject: string | null; body: string | null; audience: string | null;
  segment_id: number | null; product_id: number | null; scheduled_at: string | null;
  sent_count: number; open_count: number; click_count: number; notes: string | null;
  created_at: string; updated_at: string;
}
export interface MktEmailCampaignInput {
  name: string; type?: string; status?: string; subject?: string | null; body?: string | null;
  audience?: string | null; segment_id?: number | null; product_id?: number | null;
  scheduled_at?: string | null; notes?: string | null;
}
export function addMktEmailCampaign(input: MktEmailCampaignInput): MktEmailCampaign {
  const db = crmDb(); const now = nowISO();
  const res = db.run(`INSERT INTO mkt_email_campaigns (name,type,status,subject,body,audience,segment_id,product_id,scheduled_at,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.name, input.type ?? 'broadcast', input.status ?? 'draft', input.subject ?? null, input.body ?? null, input.audience ?? null, input.segment_id ?? null, input.product_id ?? null, input.scheduled_at ?? null, input.notes ?? null, now, now]);
  return getMktEmailCampaign(Number(res.lastInsertRowid))!;
}
export function getMktEmailCampaign(id: number): MktEmailCampaign | null {
  const row = crmDb().query('SELECT * FROM mkt_email_campaigns WHERE id = ?').get(id) as any;
  return row ? row as MktEmailCampaign : null;
}
export function listMktEmailCampaigns(status?: string): MktEmailCampaign[] {
  const db = crmDb();
  if (status) return db.query('SELECT * FROM mkt_email_campaigns WHERE status = ? ORDER BY updated_at DESC').all(status) as MktEmailCampaign[];
  return db.query('SELECT * FROM mkt_email_campaigns ORDER BY updated_at DESC').all() as MktEmailCampaign[];
}
export function updateMktEmailCampaign(id: number, patch: any): MktEmailCampaign | null {
  const db = crmDb(); const existing = getMktEmailCampaign(id); if (!existing) return null;
  const now = nowISO();
  const fields: string[] = []; const values: any[] = [];
  const updatable = ['name','type','status','subject','body','audience','segment_id','product_id','scheduled_at','sent_count','open_count','click_count','notes'];
  for (const k of updatable) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { fields.push(`${k} = ?`); values.push(patch[k] ?? null); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?'); values.push(now); values.push(id);
  db.run(`UPDATE mkt_email_campaigns SET ${fields.join(', ')} WHERE id = ?`, values);
  return getMktEmailCampaign(id);
}
export function deleteMktEmailCampaign(id: number): boolean {
  const res = crmDb().run('DELETE FROM mkt_email_campaigns WHERE id = ?', [id]);
  return (res.changes ?? 0) > 0;
}

export interface MktAd {
  id: number; name: string; platform: string; status: string;
  budget: number | null; currency: string; spend: number; impressions: number; clicks: number; conversions: number; revenue: number;
  start_date: string | null; end_date: string | null; product_id: number | null; notes: string | null;
  created_at: string; updated_at: string;
}
export interface MktAdInput {
  name: string; platform?: string; status?: string; budget?: number | null; currency?: string;
  spend?: number; impressions?: number; clicks?: number; conversions?: number; revenue?: number;
  start_date?: string | null; end_date?: string | null; product_id?: number | null; notes?: string | null;
}
export function addMktAd(input: MktAdInput): MktAd {
  const db = crmDb(); const now = nowISO();
  const res = db.run(`INSERT INTO mkt_ads (name,platform,status,budget,currency,spend,impressions,clicks,conversions,revenue,start_date,end_date,product_id,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.name, input.platform ?? 'meta', input.status ?? 'draft', input.budget ?? null, input.currency ?? 'USD', input.spend ?? 0, input.impressions ?? 0, input.clicks ?? 0, input.conversions ?? 0, input.revenue ?? 0, input.start_date ?? null, input.end_date ?? null, input.product_id ?? null, input.notes ?? null, now, now]);
  return getMktAd(Number(res.lastInsertRowid))!;
}
export function getMktAd(id: number): MktAd | null {
  const row = crmDb().query('SELECT * FROM mkt_ads WHERE id = ?').get(id) as any;
  return row ? row as MktAd : null;
}
export function listMktAds(status?: string, platform?: string): MktAd[] {
  const db = crmDb();
  const conds: string[] = []; const vals: any[] = [];
  if (status) { conds.push('status = ?'); vals.push(status); }
  if (platform) { conds.push('platform = ?'); vals.push(platform); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.query(`SELECT * FROM mkt_ads ${where} ORDER BY updated_at DESC`).all(...vals) as MktAd[];
}
export function updateMktAd(id: number, patch: any): MktAd | null {
  const db = crmDb(); const existing = getMktAd(id); if (!existing) return null;
  const now = nowISO();
  const fields: string[] = []; const values: any[] = [];
  const updatable = ['name','platform','status','budget','currency','spend','impressions','clicks','conversions','revenue','start_date','end_date','product_id','notes'];
  for (const k of updatable) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { fields.push(`${k} = ?`); values.push(patch[k] ?? null); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?'); values.push(now); values.push(id);
  db.run(`UPDATE mkt_ads SET ${fields.join(', ')} WHERE id = ?`, values);
  return getMktAd(id);
}
export function deleteMktAd(id: number): boolean {
  const res = crmDb().run('DELETE FROM mkt_ads WHERE id = ?', [id]);
  return (res.changes ?? 0) > 0;
}

export interface MktContent {
  id: number; title: string; platform: string; status: string;
  content: string | null; scheduled_date: string | null; published_url: string | null;
  product_id: number | null; notes: string | null; created_at: string; updated_at: string;
}
export interface MktContentInput {
  title: string; platform?: string; status?: string; content?: string | null;
  scheduled_date?: string | null; published_url?: string | null; product_id?: number | null; notes?: string | null;
}
export function addMktContent(input: MktContentInput): MktContent {
  const db = crmDb(); const now = nowISO();
  const res = db.run(`INSERT INTO mkt_content (title,platform,status,content,scheduled_date,published_url,product_id,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [input.title, input.platform ?? 'linkedin', input.status ?? 'idea', input.content ?? null, input.scheduled_date ?? null, input.published_url ?? null, input.product_id ?? null, input.notes ?? null, now, now]);
  return getMktContent(Number(res.lastInsertRowid))!;
}
export function getMktContent(id: number): MktContent | null {
  const row = crmDb().query('SELECT * FROM mkt_content WHERE id = ?').get(id) as any;
  return row ? row as MktContent : null;
}
export function listMktContent(status?: string, platform?: string): MktContent[] {
  const db = crmDb();
  const conds: string[] = []; const vals: any[] = [];
  if (status) { conds.push('status = ?'); vals.push(status); }
  if (platform) { conds.push('platform = ?'); vals.push(platform); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.query(`SELECT * FROM mkt_content ${where} ORDER BY COALESCE(scheduled_date, created_at) DESC`).all(...vals) as MktContent[];
}
export function updateMktContent(id: number, patch: any): MktContent | null {
  const db = crmDb(); const existing = getMktContent(id); if (!existing) return null;
  const now = nowISO();
  const fields: string[] = []; const values: any[] = [];
  const updatable = ['title','platform','status','content','scheduled_date','published_url','product_id','notes'];
  for (const k of updatable) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { fields.push(`${k} = ?`); values.push(patch[k] ?? null); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?'); values.push(now); values.push(id);
  db.run(`UPDATE mkt_content SET ${fields.join(', ')} WHERE id = ?`, values);
  return getMktContent(id);
}
export function deleteMktContent(id: number): boolean {
  const res = crmDb().run('DELETE FROM mkt_content WHERE id = ?', [id]);
  return (res.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Marketing — Cold Reachout Campaigns (mass email reachout with warmup)
// ---------------------------------------------------------------------------

export interface MktReachoutCampaign {
  id: number; name: string; status: string; segment_id: number | null; product_id: number | null;
  subject: string | null; body: string | null; audience_filter: string | null;
  daily_cap: number; buffer_min_sec: number; buffer_max_sec: number; batch_size: number;
  warmup_stage: number; start_date: string | null; from_email: string | null; notes: string | null;
  created_at: string; updated_at: string;
}
export interface MktReachoutCampaignInput {
  name: string; status?: string; segment_id?: number | null; product_id?: number | null;
  subject?: string | null; body?: string | null; audience_filter?: string | null;
  daily_cap?: number; buffer_min_sec?: number; buffer_max_sec?: number; batch_size?: number;
  warmup_stage?: number; start_date?: string | null; from_email?: string | null; notes?: string | null;
}
export function addMktReachoutCampaign(input: MktReachoutCampaignInput): MktReachoutCampaign {
  const db = crmDb(); const now = nowISO();
  const res = db.run(`INSERT INTO mkt_reachout_campaigns (name,status,segment_id,product_id,subject,body,audience_filter,daily_cap,buffer_min_sec,buffer_max_sec,batch_size,warmup_stage,start_date,from_email,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.name, input.status ?? 'draft', input.segment_id ?? null, input.product_id ?? null, input.subject ?? null, input.body ?? null, input.audience_filter ?? null, input.daily_cap ?? 30, input.buffer_min_sec ?? 120, input.buffer_max_sec ?? 300, input.batch_size ?? 10, input.warmup_stage ?? 2, input.start_date ?? null, input.from_email ?? null, input.notes ?? null, now, now]);
  return getMktReachoutCampaign(Number(res.lastInsertRowid))!;
}
export function getMktReachoutCampaign(id: number): MktReachoutCampaign | null {
  const row = crmDb().query('SELECT * FROM mkt_reachout_campaigns WHERE id = ?').get(id) as any;
  return row ? row as MktReachoutCampaign : null;
}
export function listMktReachoutCampaigns(status?: string): MktReachoutCampaign[] {
  const db = crmDb();
  if (status) return db.query('SELECT * FROM mkt_reachout_campaigns WHERE status = ? ORDER BY updated_at DESC').all(status) as MktReachoutCampaign[];
  return db.query('SELECT * FROM mkt_reachout_campaigns ORDER BY updated_at DESC').all() as MktReachoutCampaign[];
}
export function updateMktReachoutCampaign(id: number, patch: any): MktReachoutCampaign | null {
  const db = crmDb(); const existing = getMktReachoutCampaign(id); if (!existing) return null;
  const now = nowISO();
  const fields: string[] = []; const values: any[] = [];
  const updatable = ['name','status','segment_id','product_id','subject','body','audience_filter','daily_cap','buffer_min_sec','buffer_max_sec','batch_size','warmup_stage','start_date','from_email','notes'];
  for (const k of updatable) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { fields.push(`${k} = ?`); values.push(patch[k] ?? null); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?'); values.push(now); values.push(id);
  db.run(`UPDATE mkt_reachout_campaigns SET ${fields.join(', ')} WHERE id = ?`, values);
  return getMktReachoutCampaign(id);
}
export function deleteMktReachoutCampaign(id: number): boolean {
  crmDb().run('DELETE FROM mkt_reachout_queue WHERE campaign_id = ?', [id]);
  const res = crmDb().run('DELETE FROM mkt_reachout_campaigns WHERE id = ?', [id]);
  return (res.changes ?? 0) > 0;
}

export interface MktReachoutQueueRow {
  id: number; campaign_id: number; client_id: number; batch_no: number; scheduled_at: string;
  status: string; sent_at: string | null; error: string | null; created_at: string;
  client_name?: string; client_email?: string;
}
export function listMktReachoutQueue(campaignId: number): MktReachoutQueueRow[] {
  const db = crmDb();
  const rows = db.query(`SELECT q.*, c.name AS client_name, c.email AS client_email FROM mkt_reachout_queue q LEFT JOIN clients c ON c.id = q.client_id WHERE q.campaign_id = ? ORDER BY q.scheduled_at ASC`).all(campaignId) as any[];
  return rows as MktReachoutQueueRow[];
}

/** Recommended daily cap per warmup stage (research-based). */
export function reachoutRecommendedCap(stage: number): { min: number; max: number; label: string } {
  const stages: Record<number, { min: number; max: number; label: string }> = {
    0: { min: 5, max: 10, label: 'Stage 0 — Brand new domain (warmup only, no cold)' },
    1: { min: 10, max: 20, label: 'Stage 1 — Week 1-2 warmup' },
    2: { min: 20, max: 30, label: 'Stage 2 — Week 3-4 (light cold)' },
    3: { min: 30, max: 50, label: 'Stage 3 — Mature (standard cold)' },
    4: { min: 50, max: 100, label: 'Stage 4 — Fully warmed (high volume, use rotation)' },
  };
  return stages[stage] ?? stages[2];
}

/** Build a send schedule for a campaign. Splits recipients into daily batches. */
export function buildReachoutSchedule(campaignId: number, recipientIds: number[]): { queued: number } {
  const db = crmDb();
  const campaign = getMktReachoutCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  // clear existing queue
  db.run('DELETE FROM mkt_reachout_queue WHERE campaign_id = ?', [campaignId]);
  const dailyCap = Math.max(1, campaign.daily_cap);
  const bufferMin = Math.max(30, campaign.buffer_min_sec);
  const bufferMax = Math.max(bufferMin, campaign.buffer_max_sec);
  const startDate = campaign.start_date ? new Date(campaign.start_date) : new Date();
  // normalize to 9am
  startDate.setHours(9, 0, 0, 0);
  const now = nowISO();
  let queued = 0;
  recipientIds.forEach((clientId, idx) => {
    const dayOffset = Math.floor(idx / dailyCap);
    const posInDay = idx % dailyCap;
    const d = new Date(startDate.getTime() + dayOffset * 86400000);
    // spacing within day: buffer + jitter
    const avgBuffer = (bufferMin + bufferMax) / 2;
    const jitter = Math.random() * (bufferMax - bufferMin);
    const offsetSec = posInDay * (avgBuffer + jitter);
    d.setSeconds(d.getSeconds() + Math.round(offsetSec));
    const batchNo = Math.floor(idx / (campaign.batch_size || 10)) + 1;
    db.run(`INSERT INTO mkt_reachout_queue (campaign_id, client_id, batch_no, scheduled_at, status, created_at) VALUES (?,?,?,?,?,?)`,
      [campaignId, clientId, batchNo, d.toISOString(), 'queued', now]);
    queued++;
  });
  return { queued };
}

export function getReachoutStats(campaignId: number): { total: number; queued: number; sent: number; failed: number; skipped: number; next_due: string | null } {
  const db = crmDb();
  const rows = db.query('SELECT status, COUNT(*) as c FROM mkt_reachout_queue WHERE campaign_id = ? GROUP BY status').all(campaignId) as any[];
  const stats = { total: 0, queued: 0, sent: 0, failed: 0, skipped: 0, next_due: null as string | null };
  for (const r of rows) { stats.total += r.c; if (r.status === 'queued') stats.queued += r.c; if (r.status === 'sent') stats.sent += r.c; if (r.status === 'failed') stats.failed += r.c; if (r.status === 'skipped') stats.skipped += r.c; }
  const next = db.query("SELECT scheduled_at FROM mkt_reachout_queue WHERE campaign_id = ? AND status = 'queued' ORDER BY scheduled_at ASC LIMIT 1").get(campaignId) as any;
  if (next) stats.next_due = next.scheduled_at;
  return stats;
}

// ---------------------------------------------------------------------------
// Products — the AI Enablement expert's own stack (things they sell).
// ---------------------------------------------------------------------------

export interface Product {
  id: number
  name: string
  type: string
  description: string | null
  price: number | null
  currency: string
  url: string | null
  audience: string | null
  deliverable: string | null
  notes: string | null
  strategy: string | null
  strategy_generated_at: string | null
  created_at: string
  updated_at: string
}

export interface ProductInput {
  name: string
  type?: string
  description?: string | null
  price?: number | null
  currency?: string
  url?: string | null
  audience?: string | null
  deliverable?: string | null
  notes?: string | null
}

export function addProduct(input: ProductInput): Product {
  const db = crmDb()
  const now = nowISO()
  const res = db.run(
    `INSERT INTO products (name, type, description, price, currency, url, audience, deliverable, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.type ?? "product",
      input.description ?? null,
      input.price ?? null,
      input.currency ?? "EUR",
      input.url ?? null,
      input.audience ?? null,
      input.deliverable ?? null,
      input.notes ?? null,
      now,
      now,
    ],
  )
  const id = Number(res.lastInsertRowid)
  return getProduct(id)!
}

export function getProduct(id: number): Product | null {
  const db = crmDb()
  const row = db.query("SELECT * FROM products WHERE id = ?").get(id) as any
  return row ? (row as Product) : null
}

export function listProducts(type?: string): Product[] {
  const db = crmDb()
  if (type) {
    return db.query("SELECT * FROM products WHERE type = ? ORDER BY name").all(type) as Product[]
  }
  return db.query("SELECT * FROM products ORDER BY name").all() as Product[]
}

export function updateProduct(id: number, patch: any): Product | null {
  const db = crmDb()
  const existing = getProduct(id)
  if (!existing) return null
  const now = nowISO()
  const fields: string[] = []
  const values: any[] = []
  const updatable: string[] = [
    "name", "type", "description", "price", "currency", "url", "audience", "deliverable", "notes", "strategy", "strategy_generated_at",
  ]
  for (const key of updatable) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${key} = ?`)
      values.push((patch as any)[key] ?? null)
    }
  }
  if (!fields.length) return existing
  fields.push("updated_at = ?")
  values.push(now)
  values.push(id)
  db.run(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`, values)
  return getProduct(id)
}

export function deleteProduct(id: number): boolean {
  const db = crmDb()
  const res = db.run("DELETE FROM products WHERE id = ?", [id])
  return (res.changes ?? 0) > 0
}

export function productsSummary(): string {
  const rows = listProducts()
  if (!rows.length) return "No products registered yet."
  return rows
    .map((p) => {
      const price = p.price != null ? `EUR ${p.price}` : "no price set"
      const parts = [`${p.name} (${p.type}) — ${price}`]
      if (p.description) parts.push(`  ${p.description}`)
      if (p.audience) parts.push(`  Audience: ${p.audience}`)
      if (p.deliverable) parts.push(`  Deliverable: ${p.deliverable}`)
      if (p.url) parts.push(`  URL: ${p.url}`)
      return parts.join("\n")
    })
    .join("\n\n")
}

// ---------------------------------------------------------------------------
// Referrals (client-to-client and attorney-to-attorney split-fee)
// ---------------------------------------------------------------------------

export interface Referral {
  id: number; type: string; status: string;
  referrer_kind: string; referrer_client_id: number | null; referrer_person_id: number | null; referrer_name: string | null;
  referee_kind: string; referee_client_id: number | null; referee_name: string | null;
  total_value: number | null; split_percent: number | null; split_amount: number | null;
  currency: string; paid_at: string | null; notes: string | null;
  created_at: string; updated_at: string;
}
export interface ReferralInput {
  type?: string; status?: string;
  referrer_kind?: string; referrer_client_id?: number | null; referrer_person_id?: number | null; referrer_name?: string | null;
  referee_kind?: string; referee_client_id?: number | null; referee_name?: string | null;
  total_value?: number | null; split_percent?: number | null; split_amount?: number | null;
  currency?: string; paid_at?: string | null; notes?: string | null;
}
export function addReferral(input: ReferralInput): Referral {
  const db = crmDb(); const now = nowISO();
  const res = db.run(`INSERT INTO referrals (type,status,referrer_kind,referrer_client_id,referrer_person_id,referrer_name,referee_kind,referee_client_id,referee_name,total_value,split_percent,split_amount,currency,paid_at,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.type ?? 'client_to_client', input.status ?? 'pending', input.referrer_kind ?? 'client', input.referrer_client_id ?? null, input.referrer_person_id ?? null, input.referrer_name ?? null, input.referee_kind ?? 'client', input.referee_client_id ?? null, input.referee_name ?? null, input.total_value ?? null, input.split_percent ?? null, input.split_amount ?? null, input.currency ?? 'EUR', input.paid_at ?? null, input.notes ?? null, now, now]);
  const created = getReferral(Number(res.lastInsertRowid))!
  // keep referral program in sync
  try { const rr = ensureReferrerForReferral(created); if (rr) refreshReferrerStats(rr.id) } catch {}
  return created
}
export function getReferral(id: number): Referral | null {
  const row = crmDb().query('SELECT * FROM referrals WHERE id = ?').get(id) as any;
  return row ? row as Referral : null;
}
export function listReferrals(type?: string, status?: string): Referral[] {
  const db = crmDb();
  const conds: string[] = []; const vals: any[] = [];
  if (type) { conds.push('type = ?'); vals.push(type); }
  if (status) { conds.push('status = ?'); vals.push(status); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.query(`SELECT * FROM referrals ${where} ORDER BY updated_at DESC`).all(...vals) as Referral[];
}
export function updateReferral(id: number, patch: any): Referral | null {
  const db = crmDb(); const existing = getReferral(id); if (!existing) return null;
  const now = nowISO();
  const fields: string[] = []; const values: any[] = [];
  const updatable = ['type','status','referrer_kind','referrer_client_id','referrer_person_id','referrer_name','referee_kind','referee_client_id','referee_name','total_value','split_percent','split_amount','currency','paid_at','notes'];
  for (const k of updatable) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { fields.push(`${k} = ?`); values.push(patch[k] ?? null); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?'); values.push(now); values.push(id);
  db.run(`UPDATE referrals SET ${fields.join(', ')} WHERE id = ?`, values);
  const updated = getReferral(id);
  try { if (updated) { const rr = ensureReferrerForReferral(updated); if (rr) refreshReferrerStats(rr.id) } } catch {}
  return updated;
}
export function deleteReferral(id: number): boolean {
  const ref = getReferral(id)
  let rid: number | null = null
  if (ref) {
    const rr = crmDb().query("SELECT id FROM referrers WHERE person_id = ? OR client_id = ? OR name = ?").get(ref.referrer_person_id, ref.referrer_client_id, ref.referrer_name) as any
    rid = rr ? rr.id : null
  }
  const res = crmDb().run('DELETE FROM referrals WHERE id = ?', [id]);
  if (rid) try { refreshReferrerStats(rid) } catch {}
  return (res.changes ?? 0) > 0;
}

// ===== People master (a person can hold multiple roles: client, referrer, ...) =====

export interface Person {
  id: number
  name: string
  email: string | null
  phone: string | null
  birthday: string | null
  notes: string | null
  roles: string
  created_at: string
  updated_at: string
}

export interface PersonInput {
  name: string
  email?: string | null
  phone?: string | null
  birthday?: string | null
  notes?: string | null
  roles?: string[]
}

export function addPerson(input: PersonInput): Person {
  const db = crmDb()
  const now = nowISO()
  const res = db.run(
    "INSERT INTO people (name,email,phone,birthday,notes,roles,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [input.name, input.email ?? null, input.phone ?? null, input.birthday ?? null, input.notes ?? null, JSON.stringify(input.roles ?? []), now, now],
  )
  return getPerson(Number(res.lastInsertRowid))!
}

export function getPerson(id: number): Person | null {
  const row = crmDb().query("SELECT * FROM people WHERE id = ?").get(id) as any
  return row ? (row as Person) : null
}

export function listPeople(role?: string): Person[] {
  const db = crmDb()
  const all = db.query("SELECT * FROM people ORDER BY name ASC").all() as Person[]
  if (!role) return all
  return all.filter((p) => {
    try { return (JSON.parse(p.roles) as string[]).includes(role) } catch { return false }
  })
}

export function findPersonByEmail(email: string): Person | null {
  const row = crmDb().query("SELECT * FROM people WHERE email = ?").get(email) as any
  return row ? (row as Person) : null
}

export function findPersonByName(name: string): Person | null {
  const row = crmDb().query("SELECT * FROM people WHERE name = ?").get(name) as any
  return row ? (row as Person) : null
}

export function updatePerson(id: number, patch: any): Person | null {
  const db = crmDb()
  const existing = getPerson(id)
  if (!existing) return null
  const fields: string[] = []
  const values: any[] = []
  for (const k of ["name", "email", "phone", "birthday", "notes", "roles"]) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      fields.push(`${k} = ?`)
      values.push(k === "roles" && Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : (patch[k] ?? null))
    }
  }
  if (!fields.length) return existing
  fields.push("updated_at = ?")
  values.push(nowISO())
  values.push(id)
  db.run(`UPDATE people SET ${fields.join(", ")} WHERE id = ?`, values)
  return getPerson(id)
}

export function addRoleToPerson(id: number, role: string): Person | null {
  const p = getPerson(id)
  if (!p) return null
  let roles: string[] = []
  try { roles = JSON.parse(p.roles) } catch {}
  if (!roles.includes(role)) roles.push(role)
  return updatePerson(id, { roles })
}

export function promoteClientToReferrer(clientId: number): Referrer | null {
  const db = crmDb()
  const client = db.query("SELECT * FROM clients WHERE id = ?").get(clientId) as any
  if (!client) return null
  // find or create person
  let person: Person | null = client.person_id ? getPerson(client.person_id) : null
  if (!person) {
    person = addPerson({ name: client.name, email: client.email, phone: client.phone, notes: client.notes, roles: ["client", "referrer"] })
    db.run("UPDATE clients SET person_id = ? WHERE id = ?", [person.id, clientId])
  } else {
    addRoleToPerson(person.id, "referrer")
  }
  // avoid duplicate referrer for same person
  const existing = db.query("SELECT * FROM referrers WHERE person_id = ?").get(person.id) as any
  if (existing) return existing as Referrer
  return addReferrer({ name: person.name, email: person.email, phone: person.phone, birthday: person.birthday, notes: person.notes, person_id: person.id, client_id: clientId, tier: "bronze", points: 0 })
}

// ===== Referral <-> Referral Program sync =====

export function findOrCreatePersonForReferrer(ref: any): Person | null {
  if (!ref) return null
  // by person_id
  if (ref.referrer_person_id) {
    const p = getPerson(ref.referrer_person_id)
    if (p) return p
  }
  // by client
  if (ref.referrer_client_id) {
    const client = crmDb().query("SELECT * FROM clients WHERE id = ?").get(ref.referrer_client_id) as any
    if (client) {
      if (client.person_id) {
        const p = getPerson(client.person_id)
        if (p) return p
      }
      const p = addPerson({ name: client.name, email: client.email, phone: client.phone, notes: client.notes, roles: ["client", "referrer"] })
      crmDb().run("UPDATE clients SET person_id = ? WHERE id = ?", [p.id, client.id])
      return p
    }
  }
  // by name
  const name = (ref.referrer_name || "").trim()
  if (name) {
    const existing = findPersonByName(name)
    if (existing) return existing
    return addPerson({ name, roles: ["referrer"] })
  }
  return null
}

export function ensureReferrerForReferral(referral: any): Referrer | null {
  const person = findOrCreatePersonForReferrer(referral)
  if (!person) return null
  const db = crmDb()
  // link referral to person
  if (referral.id && referral.referrer_person_id !== person.id) {
    db.run("UPDATE referrals SET referrer_person_id = ? WHERE id = ?", [person.id, referral.id])
  }
  // find or create referrer
  const existing = db.query("SELECT * FROM referrers WHERE person_id = ?").get(person.id) as any
  if (existing) return existing as Referrer
  // also match by client_id
  if (referral.referrer_client_id) {
    const byClient = db.query("SELECT * FROM referrers WHERE client_id = ?").get(referral.referrer_client_id) as any
    if (byClient) {
      // link person
      db.run("UPDATE referrers SET person_id = ? WHERE id = ?", [person.id, byClient.id])
      return getReferrer(byClient.id)
    }
  }
  // by name
  const byName = db.query("SELECT * FROM referrers WHERE name = ?").get(person.name) as any
  if (byName) {
    db.run("UPDATE referrers SET person_id = ? WHERE id = ?", [person.id, byName.id])
    return getReferrer(byName.id)
  }
  return addReferrer({ name: person.name, email: person.email, phone: person.phone, birthday: person.birthday, notes: person.notes, person_id: person.id, client_id: referral.referrer_client_id ?? null, tier: "bronze", points: 0 })
}

export function refreshReferrerStats(referrerId: number): Referrer | null {
  const r = getReferrer(referrerId)
  if (!r) return null
  const db = crmDb()
  // find person
  const personId = r.person_id
  // find all referrals for this referrer
  const conds: string[] = []
  const vals: any[] = []
  if (personId) { conds.push("referrer_person_id = ?"); vals.push(personId) }
  if (r.client_id) { conds.push("referrer_client_id = ?"); vals.push(r.client_id) }
  conds.push("referrer_name = ?"); vals.push(r.name)
  const where = conds.length ? "WHERE " + conds.join(" OR ") : ""
  const refs = db.query(`SELECT * FROM referrals ${where}`).all(...vals) as any[]
  // distinct by id
  const seen = new Set<number>()
  const uniq = refs.filter((x) => { if (seen.has(x.id)) return false; seen.add(x.id); return true })
  const count = uniq.length
  let wonValue = 0
  for (const ref of uniq) {
    const status = (ref.status || "").toLowerCase()
    const won = status === "completed" || status === "paid" || status === "accepted"
    if (won && ref.referee_client_id) {
      const client = db.query("SELECT deal_value FROM clients WHERE id = ?").get(ref.referee_client_id) as any
      if (client && client.deal_value) wonValue += Number(client.deal_value)
    } else if (won && ref.total_value) {
      wonValue += Number(ref.total_value)
    }
  }
  // points: 10 per referral + 50 per completed + 100 per paid (approx)
  let points = 0
  for (const ref of uniq) {
    const status = (ref.status || "").toLowerCase()
    points += 10
    if (status === "completed") points += 40
    if (status === "paid") points += 90
  }
  // tier
  let tier: "bronze" | "silver" | "gold" = "bronze"
  if (count >= 10 || wonValue >= 20000) tier = "gold"
  else if (count >= 3 || wonValue >= 5000) tier = "silver"
  db.run("UPDATE referrers SET points = ?, tier = ?, updated_at = ? WHERE id = ?", [points, tier, nowISO(), r.id])
  return getReferrer(r.id)
}

export function getReferredLeads(referrerId: number): any[] {
  const r = getReferrer(referrerId)
  if (!r) return []
  const db = crmDb()
  const conds: string[] = []
  const vals: any[] = []
  if (r.person_id) { conds.push("referrer_person_id = ?"); vals.push(r.person_id) }
  if (r.client_id) { conds.push("referrer_client_id = ?"); vals.push(r.client_id) }
  conds.push("referrer_name = ?"); vals.push(r.name)
  const where = conds.length ? "WHERE " + conds.join(" OR ") : ""
  const refs = db.query(`SELECT * FROM referrals ${where} ORDER BY updated_at DESC`).all(...vals) as any[]
  const seen = new Set<number>()
  const uniq = refs.filter((x) => { if (seen.has(x.id)) return false; seen.add(x.id); return true })
  const out: any[] = []
  for (const ref of uniq) {
    let client: any = null
    if (ref.referee_client_id) {
      client = db.query("SELECT id,name,status,deal_value,currency,company FROM clients WHERE id = ?").get(ref.referee_client_id) as any
    }
    out.push({
      referral_id: ref.id,
      referral_status: ref.status,
      referee_name: client ? client.name : (ref.referee_name || "Unknown"),
      client_id: client ? client.id : null,
      stage: client ? client.status : null,
      deal_value: client ? client.deal_value : ref.total_value,
      currency: client ? client.currency : ref.currency,
      company: client ? client.company : null,
      split_amount: ref.split_amount,
      paid_at: ref.paid_at,
    })
  }
  return out
}

export function syncReferrersFromReferrals(): { created: number; updated: number } {
  const db = crmDb()
  const refs = db.query("SELECT * FROM referrals").all() as any[]
  let created = 0, updated = 0
  const seenReferrers = new Set<number>()
  for (const ref of refs) {
    const referrer = ensureReferrerForReferral(ref)
    if (!referrer) continue
    if (!seenReferrers.has(referrer.id)) {
      seenReferrers.add(referrer.id)
      refreshReferrerStats(referrer.id)
      updated++
    }
  }
  return { created, updated }
}

// ===== Referral Program (referrers, tiers, gamification, thank-yous) =====

export interface Referrer {
  id: number
  person_id: number | null
  name: string
  email: string | null
  phone: string | null
  birthday: string | null
  important_dates: string | null
  client_id: number | null
  tier: "bronze" | "silver" | "gold"
  points: number
  badges: string | null
  notes: string | null
  joined_at: string
  last_thank_you_at: string | null
  created_at: string
  updated_at: string
}

export interface ReferrerInput {
  name: string
  person_id?: number | null
  email?: string | null
  phone?: string | null
  birthday?: string | null
  important_dates?: string | null
  client_id?: number | null
  tier?: "bronze" | "silver" | "gold"
  points?: number
  badges?: string | null
  notes?: string | null
  joined_at?: string
}

export interface ReferralEvent {
  id: number
  referrer_id: number
  referral_id: number | null
  client_id: number | null
  event_type: string
  value: number | null
  points: number
  notes: string | null
  occurred_at: string
  created_at: string
}

export interface ReferralThankYou {
  id: number
  referrer_id: number
  channel: string
  subject: string | null
  body: string | null
  status: "draft" | "sent"
  sent_at: string | null
  created_at: string
  updated_at: string
}

const TIER_THRESHOLDS = { silver: { referrals: 3, value: 5000 }, gold: { referrals: 10, value: 20000 } }

export function recomputeReferrerTier(id: number): Referrer | null {
  const db = crmDb()
  const r = getReferrer(id)
  if (!r) return null
  const stats = db.query(
    "SELECT COUNT(*) AS n, COALESCE(SUM(value),0) AS v FROM referral_events WHERE referrer_id = ? AND event_type IN ('referral','conversion','payment')",
  ).get(id) as any
  const n = Number(stats?.n ?? 0)
  const v = Number(stats?.v ?? 0)
  let tier: "bronze" | "silver" | "gold" = "bronze"
  if (n >= TIER_THRESHOLDS.gold.referrals || v >= TIER_THRESHOLDS.gold.value) tier = "gold"
  else if (n >= TIER_THRESHOLDS.silver.referrals || v >= TIER_THRESHOLDS.silver.value) tier = "silver"
  db.run("UPDATE referrers SET tier = ?, updated_at = ? WHERE id = ?", [tier, nowISO(), id])
  return getReferrer(id)
}

export function addReferrer(input: ReferrerInput): Referrer {
  const db = crmDb()
  // If linked to a person, pull canonical identity from people (master).
  if (input.person_id) {
    const p = getPerson(input.person_id)
    if (p) {
      input.name = input.name || p.name
      input.email = input.email ?? p.email
      input.phone = input.phone ?? p.phone
      input.birthday = input.birthday ?? p.birthday
      input.notes = input.notes ?? p.notes
    }
    addRoleToPerson(input.person_id, "referrer")
  }
  const now = nowISO()
  const res = db.run(
    `INSERT INTO referrers (person_id,name,email,phone,birthday,important_dates,client_id,tier,points,badges,notes,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.person_id ?? null,
      input.name,
      input.email ?? null,
      input.phone ?? null,
      input.birthday ?? null,
      input.important_dates ?? null,
      input.client_id ?? null,
      input.tier ?? "bronze",
      input.points ?? 0,
      input.badges ?? null,
      input.notes ?? null,
      input.joined_at ?? now,
      now,
      now,
    ],
  )
  return getReferrer(Number(res.lastInsertRowid))!
}

export function getReferrer(id: number): Referrer | null {
  const row = crmDb().query("SELECT * FROM referrers WHERE id = ?").get(id) as any
  return row ? (row as Referrer) : null
}

export function listReferrers(tier?: string): Referrer[] {
  const db = crmDb()
  if (tier) return db.query("SELECT * FROM referrers WHERE tier = ? ORDER BY points DESC, name ASC").all(tier) as Referrer[]
  return db.query("SELECT * FROM referrers ORDER BY points DESC, name ASC").all() as Referrer[]
}

export function updateReferrer(id: number, patch: any): Referrer | null {
  const db = crmDb()
  const existing = getReferrer(id)
  if (!existing) return null
  const updatable = ["person_id", "name", "email", "phone", "birthday", "important_dates", "client_id", "tier", "points", "badges", "notes", "joined_at", "last_thank_you_at"]
  const fields: string[] = []
  const values: any[] = []
  for (const k of updatable) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { fields.push(`${k} = ?`); values.push(patch[k] ?? null) }
  }
  if (!fields.length) return existing
  fields.push("updated_at = ?")
  values.push(nowISO())
  values.push(id)
  db.run(`UPDATE referrers SET ${fields.join(", ")} WHERE id = ?`, values)
  return getReferrer(id)
}

export function deleteReferrer(id: number): boolean {
  const res = crmDb().run("DELETE FROM referrers WHERE id = ?", [id])
  return (res.changes ?? 0) > 0
}

export function addReferralEvent(input: { referrer_id: number; referral_id?: number | null; client_id?: number | null; event_type?: string; value?: number | null; points?: number; notes?: string | null; occurred_at?: string }): ReferralEvent {
  const db = crmDb()
  const now = nowISO()
  const occurred = input.occurred_at ?? now
  const pts = input.points ?? defaultPointsFor(input.event_type ?? "referral")
  const res = db.run(
    `INSERT INTO referral_events (referrer_id,referral_id,client_id,event_type,value,points,notes,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [input.referrer_id, input.referral_id ?? null, input.client_id ?? null, input.event_type ?? "referral", input.value ?? null, pts, input.notes ?? null, occurred, now],
  )
  // award points to referrer
  db.run("UPDATE referrers SET points = points + ?, updated_at = ? WHERE id = ?", [pts, now, input.referrer_id])
  // recompute tier
  recomputeReferrerTier(input.referrer_id)
  // award badges
  awardBadges(input.referrer_id)
  return getReferralEvent(Number(res.lastInsertRowid))!
}

function defaultPointsFor(type: string): number {
  switch (type) {
    case "referral": return 10
    case "conversion": return 50
    case "payment": return 100
    case "bonus": return 25
    default: return 5
  }
}

export function getReferralEvent(id: number): ReferralEvent | null {
  const row = crmDb().query("SELECT * FROM referral_events WHERE id = ?").get(id) as any
  return row ? (row as ReferralEvent) : null
}

export function listReferralEvents(referrer_id?: number): ReferralEvent[] {
  const db = crmDb()
  if (referrer_id) return db.query("SELECT * FROM referral_events WHERE referrer_id = ? ORDER BY occurred_at DESC").all(referrer_id) as ReferralEvent[]
  return db.query("SELECT * FROM referral_events ORDER BY occurred_at DESC").all() as ReferralEvent[]
}

export function deleteReferralEvent(id: number): boolean {
  const ev = getReferralEvent(id)
  if (!ev) return false
  const db = crmDb()
  db.run("DELETE FROM referral_events WHERE id = ?", [id])
  // subtract points
  db.run("UPDATE referrers SET points = MAX(0, points - ?), updated_at = ? WHERE id = ?", [ev.points, nowISO(), ev.referrer_id])
  recomputeReferrerTier(ev.referrer_id)
  return true
}

export function awardBadges(referrer_id: number): string[] {
  const db = crmDb()
  const r = getReferrer(referrer_id)
  if (!r) return []
  const events = listReferralEvents(referrer_id)
  const n = events.filter(e => e.event_type === "referral" || e.event_type === "conversion" || e.event_type === "payment").length
  const badges = new Set<string>((r.badges ? JSON.parse(r.badges) : []) as string[])
  if (events.length >= 1) badges.add("first_referral")
  if (n >= 5) badges.add("five_referrals")
  if (n >= 10) badges.add("ten_referrals")
  if (r.tier === "gold") badges.add("gold_tier")
  if (r.tier === "silver") badges.add("silver_tier")
  const arr = [...badges]
  db.run("UPDATE referrers SET badges = ?, updated_at = ? WHERE id = ?", [JSON.stringify(arr), nowISO(), referrer_id])
  return arr
}

export function referralLeaderboard(limit: number = 10): (Referrer & { referral_count: number; won_value: number })[] {
  const db = crmDb()
  const rows = db.query(`
    SELECT r.*,
      (SELECT COUNT(*) FROM referral_events e WHERE e.referrer_id = r.id) AS referral_count,
      (SELECT COALESCE(SUM(value),0) FROM referral_events e WHERE e.referrer_id = r.id AND e.event_type IN ('conversion','payment')) AS won_value
    FROM referrers r ORDER BY r.points DESC, referral_count DESC LIMIT ?
  `).all(limit) as any[]
  return rows.map((row) => ({ ...row, referral_count: Number(row.referral_count), won_value: Number(row.won_value) }))
}

export function upcomingReferrerBirthdays(days: number = 30): Referrer[] {
  const db = crmDb()
  const all = listReferrers()
  const today = new Date()
  const out: Referrer[] = []
  for (const r of all) {
    if (!r.birthday) continue
    // birthday stored YYYY-MM-DD (or MM-DD). Normalize.
    const b = r.birthday.trim()
    let month: number, day: number
    if (/^\d{4}-\d{2}-\d{2}$/.test(b)) { month = Number(b.slice(5, 7)); day = Number(b.slice(8, 10)) }
    else if (/^\d{2}-\d{2}$/.test(b)) { month = Number(b.slice(0, 2)); day = Number(b.slice(3, 5)) }
    else continue
    // next occurrence
    const y = today.getFullYear()
    let next = new Date(y, month - 1, day)
    if (next < new Date(today.getFullYear(), today.getMonth(), today.getDate())) next = new Date(y + 1, month - 1, day)
    const diff = (next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    if (diff >= 0 && diff <= days) out.push(r)
  }
  return out.sort((a, b) => a.birthday! < b.birthday! ? -1 : 1)
}

export function pendingThankYous(): ReferralThankYou[] {
  return crmDb().query("SELECT * FROM referral_thank_yous WHERE status = 'draft' ORDER BY created_at DESC").all() as ReferralThankYou[]
}

export function addThankYou(input: { referrer_id: number; channel?: string; subject?: string | null; body?: string | null; status?: string; sent_at?: string | null }): ReferralThankYou {
  const db = crmDb()
  const now = nowISO()
  const res = db.run(
    `INSERT INTO referral_thank_yous (referrer_id,channel,subject,body,status,sent_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [input.referrer_id, input.channel ?? "email", input.subject ?? null, input.body ?? null, input.status ?? "draft", input.sent_at ?? null, now, now],
  )
  return getThankYou(Number(res.lastInsertRowid))!
}

export function getThankYou(id: number): ReferralThankYou | null {
  const row = crmDb().query("SELECT * FROM referral_thank_yous WHERE id = ?").get(id) as any
  return row ? (row as ReferralThankYou) : null
}

export function listThankYous(referrer_id?: number): ReferralThankYou[] {
  const db = crmDb()
  if (referrer_id) return db.query("SELECT * FROM referral_thank_yous WHERE referrer_id = ? ORDER BY created_at DESC").all(referrer_id) as ReferralThankYou[]
  return db.query("SELECT * FROM referral_thank_yous ORDER BY created_at DESC").all() as ReferralThankYou[]
}

export function updateThankYou(id: number, patch: any): ReferralThankYou | null {
  const db = crmDb()
  const existing = getThankYou(id)
  if (!existing) return null
  const fields: string[] = []
  const values: any[] = []
  for (const k of ["channel", "subject", "body", "status", "sent_at"]) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) { fields.push(`${k} = ?`); values.push(patch[k] ?? null) }
  }
  if (!fields.length) return existing
  fields.push("updated_at = ?")
  values.push(nowISO())
  values.push(id)
  db.run(`UPDATE referral_thank_yous SET ${fields.join(", ")} WHERE id = ?`, values)
  if (patch.status === "sent") {
    db.run("UPDATE referrers SET last_thank_you_at = ?, updated_at = ? WHERE id = ?", [nowISO(), nowISO(), existing.referrer_id])
  }
  return getThankYou(id)
}

export function deleteThankYou(id: number): boolean {
  const res = crmDb().run("DELETE FROM referral_thank_yous WHERE id = ?", [id])
  return (res.changes ?? 0) > 0
}

export function seedReferralExample(): { ok: boolean; created: number } {
  const db = crmDb()
  // avoid duplicating if already seeded
  const existing = db.query("SELECT COUNT(*) AS n FROM referrers WHERE name IN ('Alice Rossi','Marco Bianchi','Sofia Verdi')").get() as any
  if (Number(existing?.n ?? 0) > 0) return { ok: true, created: 0 }
  let created = 0
  const a = addReferrer({ name: "Alice Rossi", email: "alice@example.com", phone: "+39 333 1112233", birthday: "1985-11-20", tier: "gold", points: 0, notes: "Top referrer — brings clinic clients." })
  created++
  const b = addReferrer({ name: "Marco Bianchi", email: "marco@example.com", phone: "+39 347 9988776", birthday: "1978-12-05", tier: "silver", points: 0, notes: "Attorney partner, split-fee referrals." })
  created++
  const c = addReferrer({ name: "Sofia Verdi", email: "sofia@example.com", birthday: "1990-11-12", tier: "bronze", points: 0, notes: "New referrer." })
  created++
  // events
  addReferralEvent({ referrer_id: a.id, event_type: "referral", value: 1200, notes: "Referred Studio Rossi (dental)" })
  addReferralEvent({ referrer_id: a.id, event_type: "conversion", value: 3500, notes: "Studio Rossi signed" })
  addReferralEvent({ referrer_id: a.id, event_type: "payment", value: 3500, notes: "Payment received" })
  addReferralEvent({ referrer_id: b.id, event_type: "referral", value: 800, notes: "Referred Avv. Conti" })
  addReferralEvent({ referrer_id: b.id, event_type: "conversion", value: 2200, notes: "Engagement signed" })
  addReferralEvent({ referrer_id: c.id, event_type: "referral", value: 500, notes: "Referred Farmacia X" })
  // thank you
  addThankYou({ referrer_id: a.id, channel: "email", subject: "Thank you, Alice!", body: "Dear Alice,\n\nThank you for referring Studio Rossi. Your support means a lot.\n\nWarm regards,\nDario", status: "draft" })
  addThankYou({ referrer_id: b.id, channel: "letter", subject: "Thank you, Marco", body: "Dear Marco,\n\nThank you for the attorney referral.\n\nBest,\nDario", status: "sent", sent_at: new Date().toISOString() })
  return { ok: true, created }
}

export function referralDashboard(): any {
  const db = crmDb()
  const total = (db.query("SELECT COUNT(*) AS n FROM referrers").get() as any)?.n ?? 0
  const byTier = db.query("SELECT tier, COUNT(*) AS n FROM referrers GROUP BY tier").all() as any[]
  const tierMap: Record<string, number> = { bronze: 0, silver: 0, gold: 0 }
  for (const r of byTier) tierMap[r.tier] = Number(r.n)
  const totalPoints = (db.query("SELECT COALESCE(SUM(points),0) AS s FROM referrers").get() as any)?.s ?? 0
  const totalEvents = (db.query("SELECT COUNT(*) AS n FROM referral_events").get() as any)?.n ?? 0
  const wonValue = (db.query("SELECT COALESCE(SUM(value),0) AS s FROM referral_events WHERE event_type IN ('conversion','payment')").get() as any)?.s ?? 0
  const upcoming = upcomingReferrerBirthdays(30)
  const pending = pendingThankYous()
  const recent = listReferralEvents().slice(0, 10)
  const top = referralLeaderboard(5)
  return {
    total_referrers: Number(total),
    by_tier: tierMap,
    total_points: Number(totalPoints),
    total_events: Number(totalEvents),
    won_value: Number(wonValue),
    upcoming_birthdays: upcoming,
    pending_thank_yous: pending.length,
    recent_events: recent,
    top_referrers: top,
  }
}
