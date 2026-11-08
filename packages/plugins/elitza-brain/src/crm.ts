/**
 * Elitza Brain — the AI Enablement CRM (Task C).
 *
 * Its own database (`~/.elitza/brain/crm.db`), deliberately separate from
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
import { BRAIN_DIR, ELITZA_HOME as _ELITZA_HOME, nowISO } from "./db.js"

export const CRM_DB_PATH = `${BRAIN_DIR}/crm.db`

/**
 * Where the CRM opens. Resolved at open time, not at import time, because
 * `ELITZA_HOME` (and therefore CRM_DB_PATH) is frozen the moment db.js loads —
 * a test that sets it later would otherwise reach the operator's real records.
 * Same override shape as GOOGLE_PLACES_URL / RESEND_URL.
 */
export function crmDbPath(): string {
  return process.env.ELITZA_CRM_DB || CRM_DB_PATH
}

export const CLIENT_STATUSES = [
  "scouted",
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
}

let instance: Database | undefined

/** Open (or return) the single connection to the CRM database. */
export function crmDb(): Database {
  if (instance) return instance
  const file = crmDbPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const conn = new Database(file, { create: true })
  conn.exec("PRAGMA journal_mode=WAL")
  conn.exec("PRAGMA foreign_keys=ON")
  conn.exec(SCHEMA)
  migrate(conn)
  instance = conn
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

/**
 * Insert a client, or return the existing one when the same business is
 * already in the CRM: a website match wins (scout data always has one when
 * the business has a site), otherwise name + address must both match.
 */
export function addClient(input: ClientInput): { client: Client; created: boolean } {
  const name = input.name.trim()
  if (!name) throw new Error("A client needs a name.")
  const status = assertStatus(input.status ?? "scouted")
  const website = input.website?.trim() || null
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
}

/** Find clients by name/vertical/website text and/or exact status, newest first. */
const SORTABLE = new Set(["name", "email", "phone", "score", "source", "status", "company", "deal_value", "created_at", "updated_at"])

export function findClients(query: ClientQuery = {}): Client[] {
  const limit = Math.max(1, Math.min(200, query.limit ?? 50))
  const offset = Math.max(0, query.offset ?? 0)
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
  return rows<Client>(`SELECT * FROM clients ${where} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`, [
    ...params,
    limit,
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
  if (!fields.length) return client
  fields.push("updated_at = ?")
  params.push(nowISO(), id)
  crmDb().run(`UPDATE clients SET ${fields.join(", ")} WHERE id = ?`, params)
  logAudit("client", id, "updated", JSON.stringify(patch))
  return getClient(id)
}

export function deleteClient(id: number): boolean {
  const client = getClient(id)
  if (!client) return false
  const db = crmDb()
  for (const table of ["client_interactions", "client_assets", "client_deals", "client_tags"]) {
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

// Run the one-time migration on module load (best effort).
try { migrateEnrichedLeads() } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Configured pipeline stages (from ~/.elitza/pipeline-stages.json, else defaults)
// ---------------------------------------------------------------------------
export function configuredStageIds(): string[] {
  try {
    const fs = require("node:fs")
    const path = require("node:path")
    const home = process.env.ELITZA_HOME || ((process.env.HOME || "") + "/.elitza")
    const file = path.join(home, "pipeline-stages.json")
    if (fs.existsSync(file)) {
      const stages = JSON.parse(fs.readFileSync(file, "utf8"))
      if (Array.isArray(stages) && stages.length) return stages.map((s: any) => String(s.id))
    }
  } catch { /* fall through */ }
  return ["scouted", "contacted", "followup_1", "followup_2", "followup_3", "yes", "no", "stale", "diagnose", "proposal", "workbook", "scheduled", "payment", "done"]
}

export function stageExists(id: string): boolean {
  return configuredStageIds().includes(id)
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
      const dir = path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "pipeline", nowISO().slice(0, 10))
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

export function importClientsCSV(csv: string): { imported: number; skipped: number } {
  const lines = csv.trim().split(/\r?\n/)
  if (lines.length < 2) return { imported: 0, skipped: 0 }
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase())
  const nameIdx = header.indexOf("name")
  if (nameIdx < 0) return { imported: 0, skipped: lines.length - 1 }
  let imported = 0, skipped = 0
  for (let i = 1; i < lines.length; i++) {
    // naive csv split (no quoted commas) — good enough for simple exports
    const cols = lines[i].split(",")
    const name = (cols[nameIdx] ?? "").trim().replace(/^"|"$/g, "")
    if (!name) { skipped++; continue }
    const get = (k: string) => {
      const idx = header.indexOf(k)
      return idx >= 0 ? (cols[idx] ?? "").trim().replace(/^"|"$/g, "") : ""
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
  const elitzaHome = process.env.ELITZA_HOME || (home + "/.elitza")
  const out = path.join(home, "elitza-backup-" + new Date().toISOString().slice(0, 10) + ".tar.gz")
  try {
    execSync("tar -czf " + out + " -C " + home + " .elitza", { stdio: "pipe" })
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
  budget: number | null; currency: string; spend: number; impressions: number; clicks: number; conversions: number;
  start_date: string | null; end_date: string | null; product_id: number | null; notes: string | null;
  created_at: string; updated_at: string;
}
export interface MktAdInput {
  name: string; platform?: string; status?: string; budget?: number | null; currency?: string;
  spend?: number; impressions?: number; clicks?: number; conversions?: number;
  start_date?: string | null; end_date?: string | null; product_id?: number | null; notes?: string | null;
}
export function addMktAd(input: MktAdInput): MktAd {
  const db = crmDb(); const now = nowISO();
  const res = db.run(`INSERT INTO mkt_ads (name,platform,status,budget,currency,spend,impressions,clicks,conversions,start_date,end_date,product_id,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.name, input.platform ?? 'meta', input.status ?? 'draft', input.budget ?? null, input.currency ?? 'USD', input.spend ?? 0, input.impressions ?? 0, input.clicks ?? 0, input.conversions ?? 0, input.start_date ?? null, input.end_date ?? null, input.product_id ?? null, input.notes ?? null, now, now]);
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
  const updatable = ['name','platform','status','budget','currency','spend','impressions','clicks','conversions','start_date','end_date','product_id','notes'];
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
