/**
 * Elitza Brain — Mach 1 Tower integration bridge.
 *
 * Bidirectional, authenticated bridge between the local CRM (crm.db) and
 * Mach 1 Tower. Tower triggers staged workflows from CRM events; Tower
 * writes structured briefs, call kits, drafts and lifecycle actions back.
 *
 * Config (env):
 *   TOWER_WEBHOOK_URL      outbound POST target for CRM -> Tower dispatches
 *   TOWER_WEBHOOK_TOKEN    optional Bearer sent to Tower
 *   TOWER_CALLBACK_SECRET  required Bearer for inbound Tower -> CRM callbacks
 *   TOWER_CALLBACK_URL     callback URL advertised to Tower in payloads
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)
import { Agent, fetch as undiciFetch } from "undici"
import { AI_ENABLEMENT_HOME, nowISO } from "./db.js"
import {
  crmDb,
  getClient,
  updateClient,
  logInteraction,
  addAsset,
  getCustomFields,
  setCustomField,
  listTags,
  listDeals,
  listInteractions,
  listAssets,
  listEmails,
} from "./crm.js"
import { writeDraft } from "./outreach.js"
import { advance } from "./production.js"
import { dispose } from "./outreach.js"
import { promoteClientToReferrer, addThankYou } from "./crm.js"
import { logAudit } from "./crm.js"

export type TowerEvent =
  | "outbound_prep"
  | "inbound_received"
  | "call_prep"
  | "call_completed"
  | "milestone_update"
  | "payment_check"
  | "job_done_paid"

const VALID_EVENTS: TowerEvent[] = [
  "outbound_prep",
  "inbound_received",
  "call_prep",
  "call_completed",
  "milestone_update",
  "payment_check",
  "job_done_paid",
]

// ---- local website scraping (pre-scrape for Tower) ----
const SCRAPE_SLUGS = ["contatti", "sede-e-contatti", "contact", "chi-siamo", "lo-studio", "team", "servizi", "prestazioni", "ambulatori", "sedi"]
const SCRAPE_ALLOWED_EMAIL_LOCALS = new Set(["info", "segreteria", "contatti", "studio", "amministrazione"])
const SCRAPE_BLOCKED_TOKENS = ["/alid/v1/widget.js", "/intake/", "/checkout", "/payment", "/pay", "waffo", "paypal", "pec@", "legalmail", "postacertificata", "certificata"]

function scrapeBlockedUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return SCRAPE_BLOCKED_TOKENS.some((p) => lower.includes(p))
}

function stripHtmlToText(html: string): string {
  let t = html
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ")
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ")
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
  t = t.replace(/<[^>]+>/g, " ")
  t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  t = t.replace(/\s+/g, " ").trim()
  return t
}

function isBlockedEmail(email: string): boolean {
  const lower = email.toLowerCase()
  const local = lower.split("@")[0]
  if (["pec", "postacertificata", "certificata", "privacy", "dpo", "legale", "fatturazione", "noreply", "no-reply", "no_reply"].includes(local)) return true
  if (lower.includes("legalmail") || lower.includes("arubapec") || lower.includes("telecompost") || lower.includes(".pec.")) return true
  return false
}

function extractAllowedEmails(text: string, html: string): string[] {
  const found = new Set<string>()
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const email = m[0].toLowerCase()
    if (!isBlockedEmail(email)) found.add(email)
  }
  const mailtoRe = /mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi
  while ((m = mailtoRe.exec(html)) !== null) {
    const email = m[1].toLowerCase()
    if (!isBlockedEmail(email)) found.add(email)
  }
  // prioritize: listed locals first, then others
  const prioritized = [...found].sort((a, b) => {
    const la = a.split("@")[0]
    const lb = b.split("@")[0]
    const pa = SCRAPE_ALLOWED_EMAIL_LOCALS.has(la) ? 0 : 1
    const pb = SCRAPE_ALLOWED_EMAIL_LOCALS.has(lb) ? 0 : 1
    return pa - pb
  })
  return prioritized
}

export interface ScrapeResult {
  fetch_ok: boolean
  site_text: string
  pages_fetched: string[]
  extracted_emails: string[]
}

const relaxedAgent = new Agent({ connect: { rejectUnauthorized: false } })

const BROWSER_BIN = (() => {
  for (const b of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      execFileSync("which", [b], { stdio: "ignore" })
      return b
    } catch { /* not found */ }
  }
  return null
})()

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
}

async function fetchHtmlRelaxed(url: string): Promise<{ ok: boolean; html: string; status: number }> {
  // Stage 1: undici with relaxed SSL + Chrome headers (12s)
  try {
    const res = await undiciFetch(url, {
      method: "GET",
      headers: BROWSER_HEADERS,
      dispatcher: relaxedAgent,
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    })
    if (res.ok) {
      const ct = res.headers.get("content-type") || ""
      if (ct.includes("text/html") || ct.includes("text/plain")) {
        const html = await res.text()
        if (html && html.length >= 50) return { ok: true, html, status: res.status }
      }
    }
  } catch { /* fall through */ }

  // Stage 2: curl HTTP/1.1 fallback (15s, -k relaxed SSL)
  try {
    const { stdout } = await execFileAsync("curl", [
      "-skL", "--http1.1", "--max-time", "15",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-H", "Accept-Language: it-IT,it;q=0.9,en;q=0.8",
      url,
    ], { encoding: "utf8", timeout: 20000 })
    if (stdout && stdout.length >= 50) return { ok: true, html: stdout, status: 200 }
  } catch { /* fall through */ }

  // Stage 3: headless browser dump-dom (15s)
  if (BROWSER_BIN) {
    try {
      const { stdout } = await execFileAsync(BROWSER_BIN, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", url], {
        encoding: "utf8",
        timeout: 15000,
      })
      if (stdout && stdout.length >= 50) return { ok: true, html: stdout, status: 200 }
    } catch { /* fall through */ }
  }

  return { ok: false, html: "", status: 0 }
}

export async function scrapeWebsiteLocal(rawUrl: string | null | undefined): Promise<ScrapeResult> {
  const result: ScrapeResult = { fetch_ok: false, site_text: "", pages_fetched: [], extracted_emails: [] }
  if (!rawUrl) return result
  let host = String(rawUrl).trim()
  host = host.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase()
  if (!host || host.includes(" ")) return result

  // candidate urls: homepage variants first, then internal slugs
  const candidateUrls: string[] = []
  candidateUrls.push(`https://www.${host}/`)
  candidateUrls.push(`https://${host}/`)
  for (const slug of SCRAPE_SLUGS) {
    candidateUrls.push(`https://www.${host}/${slug}`)
    candidateUrls.push(`https://${host}/${slug}`)
  }

  const fetched: { url: string; text: string; html: string }[] = []
  const seen = new Set<string>()
  const deadline = Date.now() + 25000

  for (const url of candidateUrls) {
    if (Date.now() > deadline) break
    if (result.site_text && fetched.reduce((a, b) => a + b.text.length, 0) >= 20000) break
    if (scrapeBlockedUrl(url)) continue
    let key: string
    try {
      const u = new URL(url)
      key = u.hostname + u.pathname.replace(/\/$/, "")
    } catch { continue }
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const r = await fetchHtmlRelaxed(url)
      if (!r.ok) continue
      const html = r.html
      const text = stripHtmlToText(html)
      if (text.length < 50) continue
      fetched.push({ url, text, html })
    } catch {
      // ignore, try next
    }
  }

  // homepage = first successful fetch; subpages = next successful non-homepage fetches (up to 2)
  const homeEntry = fetched.length > 0 ? fetched[0] : null
  const subEntries: typeof fetched = []
  for (let i = 1; i < fetched.length && subEntries.length < 2; i++) {
    try {
      const u = new URL(fetched[i].url)
      if (u.pathname === "/" || u.pathname === "") continue
      subEntries.push(fetched[i])
    } catch { /* skip */ }
  }

  // Build text with caps
  let combined = ""
  const pagesFetched: string[] = []
  if (homeEntry) {
    const cap = Math.min(homeEntry.text.length, 12000)
    combined += homeEntry.text.slice(0, cap)
    pagesFetched.push(homeEntry.url)
  }
  const allEmails = new Set<string>()
  if (homeEntry) for (const e of extractAllowedEmails(homeEntry.text, homeEntry.html)) allEmails.add(e)

  for (const sub of subEntries) {
    if (combined.length >= 20000) break
    const remaining = 20000 - combined.length
    const cap = Math.min(sub.text.length, 5000, remaining)
    if (cap <= 0) break
    combined += "\n\n" + sub.text.slice(0, cap)
    pagesFetched.push(sub.url)
    for (const e of extractAllowedEmails(sub.text, sub.html)) allEmails.add(e)
  }

  result.site_text = combined.slice(0, 20000)
  result.pages_fetched = pagesFetched
  result.extracted_emails = [...allEmails]
  result.fetch_ok = fetched.length > 0
  return result
}

// backward-compat alias
export const scrapeSite = scrapeWebsiteLocal

export interface TowerConfig {
  webhookUrl: string | null
  webhookToken: string | null
  callbackSecret: string | null
  callbackUrl: string | null
}

export function towerConfig(): TowerConfig {
  return {
    webhookUrl: process.env.TOWER_WEBHOOK_URL?.trim() || null,
    webhookToken: process.env.TOWER_WEBHOOK_TOKEN?.trim() || null,
    callbackSecret: process.env.TOWER_CALLBACK_SECRET?.trim() || null,
    callbackUrl: process.env.TOWER_CALLBACK_URL?.trim() || null,
  }
}

function rows<T>(sql: string, params: unknown[] = []): T[] {
  return crmDb().query(sql).all(...(params as never[])) as T[]
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export interface TowerPayload {
  event: TowerEvent
  sent_at: string
  callback_url: string | null
  client: unknown
  custom_fields: Record<string, string>
  tags: string[]
  deals: unknown[]
  recent_interactions: unknown[]
  recent_emails: unknown[]
  recent_assets: { id: number; kind: string; name: string; status: string | null; created_at: string }[]
  referrer_profile: unknown | null
  event_payload: Record<string, unknown> | null
}

export function buildTowerPayload(
  clientId: number,
  event: TowerEvent,
  eventPayload?: Record<string, unknown>,
): TowerPayload {
  const client = getClient(clientId)
  const customFields = getCustomFields(clientId)
  const tags = listTags(clientId)
  const deals = listDeals(clientId)
  const interactions = listInteractions(clientId)
  const recentInteractions = interactions.slice(-10)
  const emails = listEmails({ client_id: clientId, limit: 5 })
  const assets = listAssets(clientId)
  const recentAssets = assets.slice(-5).map((a) => ({
    id: a.id,
    kind: a.kind,
    name: a.name,
    status: a.status,
    created_at: a.created_at,
  }))
  // referrer profile matching by client_id or person_id
  let referrerProfile: unknown | null = null
  try {
    const clientRow = client as { person_id?: number } | null
    const personId = clientRow?.person_id
    const q = personId
      ? "SELECT * FROM referrers WHERE client_id = ? OR person_id = ? LIMIT 1"
      : "SELECT * FROM referrers WHERE client_id = ? LIMIT 1"
    const params = personId ? [clientId, personId] : [clientId]
    const r = crmDb().query(q).get(...(params as never[]))
    referrerProfile = r ?? null
  } catch {
    referrerProfile = null
  }

  return {
    event,
    sent_at: nowISO(),
    callback_url: towerConfig().callbackUrl,
    client,
    custom_fields: customFields,
    tags,
    deals,
    recent_interactions: recentInteractions,
    recent_emails: emails,
    recent_assets: recentAssets,
    referrer_profile: referrerProfile,
    event_payload: eventPayload ?? null,
  }
}

export interface DispatchResult {
  ok: boolean
  skipped?: boolean
  reason?: string
  status?: number
  error?: string
}

export async function dispatchToTower(
  clientId: number,
  event: TowerEvent,
  eventPayload?: Record<string, unknown>,
): Promise<DispatchResult> {
  const cfg = towerConfig()
  if (!cfg.webhookUrl) {
    return { ok: false, skipped: true, reason: "TOWER_WEBHOOK_URL not configured" }
  }
  // Pre-scrape the client's website locally (for outbound_prep) so Tower gets
  // clean text even when Italian hosting firewalls block cloud IPs.
  let finalEventPayload = eventPayload ? { ...eventPayload } : {}
  if (event === "outbound_prep") {
    const client = getClient(clientId)
    if (client?.status === "manual_check") {
      finalEventPayload.force = true
    }
    if (client?.website) {
      const scraped = await scrapeSite(client.website)
      finalEventPayload.scraped_site_text = scraped.site_text
      finalEventPayload.scraped_pages_fetched = scraped.pages_fetched
      finalEventPayload.scraped_emails = scraped.extracted_emails
      if (!scraped.fetch_ok) finalEventPayload.scraped_site_text = ""
    } else {
      finalEventPayload.scraped_site_text = ""
      finalEventPayload.scraped_pages_fetched = 0
      finalEventPayload.scraped_emails = []
    }
  }
  const payload = buildTowerPayload(clientId, event, finalEventPayload)
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    let isMach1 = false
    let machBot = ""
    let machLabel = ""
    let machEnv = ""
    try {
      if (cfg.webhookUrl) {
        const u = new URL(cfg.webhookUrl)
        isMach1 = u.hostname.endsWith("mach1ai.com")
        machBot = u.searchParams.get("bot_identifier") || ""
        machLabel = u.searchParams.get("label") || ""
        machEnv = u.searchParams.get("environment") || ""
      }
    } catch {}
    if (cfg.webhookToken) {
      if (isMach1) headers["api-key"] = cfg.webhookToken
      else headers["Authorization"] = `Bearer ${cfg.webhookToken}`
    }
    // Mach 1 V3 required headers
    if (isMach1) {
      if (machBot) headers["bot-identifier"] = machBot
      if (machEnv) headers["environment"] = machEnv
      if (machLabel) headers["label"] = machLabel
      headers["timezone"] = "Europe/Rome"
    }
    const res = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    try {
      logAudit("tower", clientId, "dispatched", JSON.stringify({ event, status: res.status }))
    } catch {}
    if (!res.ok) {
      let detail = ""
      try { detail = (await res.text()).slice(0, 400) } catch {}
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${detail}`.trim() }
    }
    return { ok: true, status: res.status }
  } catch (error) {
    try { logAudit("tower", clientId, "dispatch_failed", String(error)) } catch {}
    return { ok: false, error: String(error) }
  }
}

// --- callback handling ---

export interface CallbackResult {
  ok: boolean
  status: number
  error?: string
  result?: unknown
}

const ALLOWED_CLIENT_PATCH = new Set([
  "status",
  "deal_value",
  "notes",
  "next_action",
  "next_action_at",
  "language",
  "priority_tier",
  "tier_label",
  "risk_level",
  "risk_score",
  "risk_notes",
  "tech_stack",
  "revenue_estimate",
  "employee_count",
])

export async function handleTowerCallback(
  reqBody: any,
  authHeader: string | null,
): Promise<CallbackResult> {
  const cfg = towerConfig()
  const secret = cfg.callbackSecret
  if (!secret) return { ok: false, status: 401, error: "TOWER_CALLBACK_SECRET not set" }

  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim()
  if (!token || !timingSafeEqual(token, secret)) {
    return { ok: false, status: 401, error: "invalid bearer token" }
  }

  const body = reqBody ?? {}
  const clientId = Number(body.client_id)
  if (!Number.isFinite(clientId)) return { ok: false, status: 400, error: "client_id required" }
  const client = getClient(clientId)
  if (!client) return { ok: false, status: 400, error: "unknown client" }
  const action = String(body.action ?? "").trim()
  if (!action) return { ok: false, status: 400, error: "action required" }

  try {
    logAudit("tower", clientId, `callback:${action}`, JSON.stringify(body).slice(0, 500), "tower")
  } catch {}

  try {
    switch (action) {
      case "update_client": {
        const patch: Record<string, unknown> = {}
        const src = body.patch && typeof body.patch === "object" ? body.patch : body
        for (const key of ALLOWED_CLIENT_PATCH) {
          if (src && src[key] !== undefined) patch[key] = src[key]
        }
        if (Object.keys(patch).length) updateClient(clientId, patch as any)
        if (body.custom_fields && typeof body.custom_fields === "object") {
          for (const [k, v] of Object.entries(body.custom_fields)) {
            setCustomField(clientId, String(k), String(v ?? ""))
          }
        }
        return { ok: true, status: 200, result: { updated: Object.keys(patch), custom_fields: body.custom_fields ? Object.keys(body.custom_fields) : [] } }
      }
      case "log_interaction": {
        const inp = body.interaction ?? body
        const interaction = logInteraction(clientId, {
          kind: String(inp.kind ?? "note"),
          direction: inp.direction ? String(inp.direction) : undefined,
          channel: inp.channel ? String(inp.channel) : undefined,
          status: inp.status ? String(inp.status) : undefined,
          subject: inp.subject ? String(inp.subject) : undefined,
          body: inp.body ? String(inp.body) : undefined,
          occurred_at: inp.occurred_at ? String(inp.occurred_at) : undefined,
        })
        return { ok: true, status: 200, result: { interaction_id: interaction.id } }
      }
      case "attach_asset": {
        const kind = String(body.kind ?? "note")
        const name = String(body.name ?? "tower-asset")
        const content = body.content
        const rawFilename = String(body.filename ?? `${name}.md`)
        if (rawFilename.includes("..") || rawFilename.includes("/") || rawFilename.includes("\\")) {
          return { ok: false, status: 400, error: "invalid filename" }
        }
        const filename = path.basename(rawFilename)
        const day = nowISO().slice(0, 10)
        const dir = path.join(AI_ENABLEMENT_HOME, "pipeline", day)
        fs.mkdirSync(dir, { recursive: true })
        const filePath = path.join(dir, filename)
        // ensure inside pipeline dir
        const resolved = path.resolve(filePath)
        const base = path.resolve(path.join(AI_ENABLEMENT_HOME, "pipeline"))
        if (!resolved.startsWith(base + path.sep)) {
          return { ok: false, status: 400, error: "path traversal blocked" }
        }
        let text = ""
        if (typeof content === "string") text = content
        else if (content !== undefined) text = JSON.stringify(content, null, 2)
        fs.writeFileSync(resolved, text, { mode: 0o644 })
        const asset = addAsset(clientId, { kind, name, path: resolved, status: body.status ? String(body.status) : "draft" })
        if (kind === "call_kit") {
          let stored: unknown = content
          if (typeof content === "string") {
            try { stored = JSON.parse(content) } catch { stored = content }
          }
          setCustomField(clientId, "tower_call_kit", JSON.stringify(stored))
        }
        return { ok: true, status: 200, result: { asset_id: asset.id, path: resolved } }
      }
      case "queue_outreach_draft": {
        const subject = String(body.subject ?? "").trim()
        const bodyText = String(body.body ?? "").trim()
        if (!subject || !bodyText) return { ok: false, status: 400, error: "subject and body required" }
        const { row } = writeDraft(clientId, {
          subject,
          body: bodyText,
          variant: body.variant ? String(body.variant) : undefined,
          from: body.from ? String(body.from) : undefined,
        })
        return { ok: true, status: 200, result: { pipeline_id: row.id } }
      }
      case "queue_email_draft": {
        const subject = body.subject ? String(body.subject) : null
        const bodyText = body.body ? String(body.body) : null
        const html = body.html ? String(body.html) : null
        const { createEmail } = await import("./crm.js")
        const email = createEmail({
          folder: "drafts",
          direction: "out",
          client_id: clientId,
          subject: subject ?? undefined,
          body: bodyText ?? undefined,
          html: html ?? undefined,
          occurred_at: nowISO(),
          from_addr: body.from ? String(body.from) : undefined,
          to_addr: body.to ? String(body.to) : (client.email ?? undefined),
        })
        return { ok: true, status: 200, result: { email_id: email.id } }
      }
      case "dispose_outreach": {
        const pipelineRow = rows<{ id: number }>("SELECT id FROM pipeline WHERE client_id = ?", [clientId])[0]
        if (!pipelineRow) return { ok: false, status: 400, error: "no pipeline row" }
        const verdict = String(body.verdict ?? "stale")
        const r = dispose(pipelineRow.id, verdict, body.note ? String(body.note) : undefined)
        return { ok: true, status: 200, result: { client_status: r.client_status } }
      }
      case "advance_stage": {
        const stage = String(body.stage ?? "").trim()
        if (!stage) return { ok: false, status: 400, error: "stage required" }
        const r = advance(clientId, stage, { note: body.note ? String(body.note) : undefined })
        return { ok: true, status: 200, result: r }
      }
      case "create_referral_thank_you": {
        const referrer = promoteClientToReferrer(clientId)
        if (!referrer) return { ok: false, status: 400, error: "could not promote referrer" }
        const ty = addThankYou({
          referrer_id: referrer.id,
          channel: body.channel ? String(body.channel) : "email",
          subject: body.subject ? String(body.subject) : null,
          body: body.body ? String(body.body) : null,
          status: "draft",
        })
        return { ok: true, status: 200, result: { thank_you_id: ty.id, referrer_id: referrer.id } }
      }
      case "scrape_site": {
        const url = String(body.url ?? "").trim()
        if (!url) return { ok: false, status: 400, error: "url required" }
        if (scrapeBlockedUrl(url)) return { ok: false, status: 400, error: "url blocked" }
        const scraped = await scrapeSite(url)
        return { ok: true, status: 200, result: { fetch_ok: scraped.fetch_ok, site_text: scraped.site_text, pages_fetched: scraped.pages_fetched, extracted_emails: scraped.extracted_emails } }
      }
      default:
        return { ok: false, status: 400, error: `unknown action ${action}` }
    }
  } catch (error) {
    return { ok: false, status: 400, error: String(error) }
  }
}
