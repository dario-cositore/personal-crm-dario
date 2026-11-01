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

export type ClientStatus = (typeof CLIENT_STATUSES)[number]

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
      risk_level TEXT,
      risk_score INTEGER,
      risk_notes TEXT,
      tech_stack TEXT,
      revenue_estimate TEXT,
      employee_count TEXT,
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
  const clientCols = db.query("PRAGMA table_info(clients)").all() as { name: string }[]
  const newCols: { name: string; type: string }[] = [
    { name: "linkedin", type: "TEXT" },
    { name: "twitter", type: "TEXT" },
    { name: "facebook", type: "TEXT" },
    { name: "instagram", type: "TEXT" },
    { name: "company", type: "TEXT" },
    { name: "risk_level", type: "TEXT" },
    { name: "risk_score", type: "INTEGER" },
    { name: "risk_notes", type: "TEXT" },
    { name: "tech_stack", type: "TEXT" },
    { name: "revenue_estimate", type: "TEXT" },
    { name: "employee_count", type: "TEXT" },
  ]
  for (const col of newCols) {
    if (!clientCols.some((c) => c.name === col.name)) {
      db.exec(`ALTER TABLE clients ADD COLUMN ${col.name} ${col.type}`)
    }
  }
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
  risk_level: string | null
  risk_score: number | null
  risk_notes: string | null
  tech_stack: string | null
  revenue_estimate: string | null
  employee_count: string | null
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
  risk_level?: string
  risk_score?: number
  risk_notes?: string
  tech_stack?: string
  revenue_estimate?: string
  employee_count?: string
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
  if ((CLIENT_STATUSES as readonly string[]).includes(status)) return status as ClientStatus
  throw new Error(`Unknown status "${status}". Valid: ${CLIENT_STATUSES.join(", ")}`)
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
    "risk_level",
    "risk_score",
    "risk_notes",
    "tech_stack",
    "revenue_estimate",
    "employee_count",
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
        input.risk_level ?? null,
        input.risk_score ?? null,
        input.risk_notes ?? null,
        input.tech_stack ?? null,
        input.revenue_estimate ?? null,
        input.employee_count ?? null,
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
  "risk_level",
  "risk_score",
  "risk_notes",
  "tech_stack",
  "revenue_estimate",
  "employee_count",
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
  const contacted = clients.filter((c) => c.status !== "scouted").length
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
