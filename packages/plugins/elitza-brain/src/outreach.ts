/**
 * Elitza Brain — the outreach pipeline (Task D).
 *
 * The order of operations, all of it local and reviewable:
 *   add      push a CRM client into the pipeline (stage scouted)
 *   draft    write the next touch as a file in ~/.ai-enablement-agent/pipeline/<date>/
 *   approve  batch-approve drafts after a human read of those files
 *   send     POST the approved drafts through Resend, then advance the stage
 *
 * Two decisions Dario made on 2026-10-24 (blueprint §9, no longer open):
 *   channel    email, through Resend — the operator's own RESEND_API_KEY
 *   approval   batch: drafts wait as files until approved together, then one
 *              command sends what was approved. Nothing sends unapproved.
 *
 * Source of truth split: the FILE owns content (to/subject/body — a human may
 * edit it before approving), the ROW owns state (stage, touch, sent_at).
 * Every sent touch also moves the client's status and last_contact, so the
 * cadence in Task E can work off one column.
 *
 * Compliance is not optional: the footer (public-listing reason, opt-out,
 * OUTREACH_SIGNATURE) is written into the draft at draft time, so the human
 * reviews it along with the message.
 *
 * Endpoint policy: official Resend API, overridable with RESEND_URL the same
 * way GOOGLE_PLACES_URL and GAPFEED_LOCAL_URL are — tests never email anyone.
 *
 * Config (env):
 *   RESEND_API_KEY      required to send; operator's own key, mode 600 .env
 *   RESEND_FROM         default verified sender, e.g. "Dario Cositore <dario@mail.dariocositore.com>"
 *   RESEND_FROM_SALES   cold outreach / sales sender (defaults to RESEND_FROM)
 *   RESEND_FROM_SUPPORT support sender (defaults to RESEND_FROM)
 *   RESEND_FROM_HELLO   soft-touch / hello sender (defaults to RESEND_FROM)
 *   RESEND_FROM_OUTREACH cold outreach alias for RESEND_FROM_SALES
 *   OUTREACH_SIGNATURE  the line under the opt-out in every footer
 */

import fs from "node:fs"
import path from "node:path"
import { AI_ENABLEMENT_HOME, nowISO } from "./db.js"
import { crmDb, getClient, logInteraction, updateClient, stageExists } from "./crm.js"
import { routeClientTrack } from "./routing.js"
import { soulGet } from "./soul.js"
import { slug } from "./pipeline.js"
import { isSendableOutreachEmail } from "./email_gate.js"

const DEFAULT_RESEND_URL = "https://api.resend.com/emails"
const FETCH_TIMEOUT_MS = 10_000
const PIPELINE_DIR = path.join(AI_ENABLEMENT_HOME, "pipeline")
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Resolve a sender preset or full address to a verified "Name <email>" string.
 *
 * Presets (case-insensitive): sales, support, hello, outreach, cold.
 * Each resolves to RESEND_FROM_<PRESET> env var, falling back to RESEND_FROM.
 * A full email address (contains @) is used directly with the default display name.
 * Undefined/empty falls back to RESEND_FROM.
 */
function resolveSender(input: string | undefined): string {
  const fallback = process.env.RESEND_FROM?.trim() || ""
  if (!input) return fallback
  const trimmed = input.trim()
  if (!trimmed) return fallback
  const preset = trimmed.toLowerCase()
  const presets: Record<string, string | undefined> = {
    sales: process.env.RESEND_FROM_SALES?.trim(),
    support: process.env.RESEND_FROM_SUPPORT?.trim(),
    hello: process.env.RESEND_FROM_HELLO?.trim(),
    outreach: process.env.RESEND_FROM_OUTREACH?.trim(),
    cold: process.env.RESEND_FROM_OUTREACH?.trim(),
  }
  if (preset in presets) {
    return presets[preset] || fallback
  }
  // Full address provided — use as-is (with default display name if bare email).
  if (trimmed.includes("@")) {
    if (trimmed.includes("<")) return trimmed
    return `Dario Cositore <${trimmed}>`
  }
  return fallback
}
export const CADENCE_DAYS = [3, 7, 14]

/** Stage reached once touch n has gone out. */
const TOUCH_STAGES = ["contacted", "followup_1", "followup_2", "followup_3"]

export interface OutreachRow {
  id: number
  client_id: number
  stage: string
  channel: string
  touch: number
  draft_path: string | null
  approved: number
  queued_touch: number
  last_touch_at: string | null
  next_touch_at: string | null
  created_at: string
  updated_at: string
}

interface DraftFile {
  to: string
  from: string
  subject: string
  body: string
  sendText: string
  touch: number
}

function resendUrl(): string {
  return (process.env.RESEND_URL || DEFAULT_RESEND_URL).replace(/\/$/, "")
}

function rows<T>(sql: string, params: unknown[] = []): T[] {
  return crmDb().query(sql).all(...(params as never[])) as T[]
}

function row<T>(sql: string, params: unknown[] = []): T | undefined {
  return crmDb().query(sql).get(...(params as never[])) as T | undefined
}

export const LOCKED_IT_PIVOT =
  "Magari hai già tutto sotto controllo. Se così non fosse e hai curiosità sulle capacità reali dell'IA nel tuo contesto, ti va di sentirci 15 minuti questa settimana per capire se ha senso approfondire?"

export const LOCKED_IT_SIGNATURE = [
  "Un saluto,",
  "",
  "Dario Cositore",
  "Sistemi IA & Operatività",
  "Castelleone (CR) / Milano | dariocositore.com/it",
  "",
  "P.S. Lavoriamo direttamente sopra gli strumenti che usate già, senza dover cambiare gestionale o abitudini in segreteria.",
].join("\n")

export const LOCKED_EN_SIGNATURE = [
  "Best,",
  "",
  "Dario Cositore",
  "AI Systems & Operations",
  "Milan, Italy | dariocositore.com",
  "",
  "P.S. Everything runs on top of the tools your team already uses, with no need to rip out your current software.",
].join("\n")

export function footer(lang?: string): string {
  return lang === "it" ? LOCKED_IT_SIGNATURE : LOCKED_EN_SIGNATURE
}

/** Strip trailing signature/footer so body-only word counts and edits never double-append signatures. */
export function stripFooter(text: string): string {
  const markers = [
    "\\n---\\nYou are receiving this because your business details are publicly listed.",
    "\\n---\\nRicevi questo messaggio perché i dati della tua attività sono pubblici.",
  ]
  let out = text
  for (const m of markers) {
    const idx = out.lastIndexOf(m)
    if (idx >= 0) out = out.slice(0, idx)
  }
  out = out.replace(
    /\n+(?:Un saluto|Cordiali saluti|A presto|Best|Best regards|Regards),?\s*\n+Dario(?:\s+Cositore)?[\s\S]*$/i,
    "",
  )
  return out.trim()
}

export function ensureSignaturePreserved(rawPostFrontmatter: string, lang?: string): string {
  const trimmed = rawPostFrontmatter.trim()
  if (/Dario\\s+Cositore[\\s\\S]*P\\.S\\./.test(trimmed)) {
    return trimmed
  }
  const cleanBody = stripFooter(trimmed)
  return `${cleanBody}\\n\\n${footer(lang)}`
}

/** Strictly case-sensitive AI -> IA replacement for Italian copy. Never alters lowercase "ai". */
export function replaceCaseSensitiveAI(text: string): string {
  return text.replace(/\b(?:AI|A\.I\.)/g, "IA")
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => /[A-Za-zÀ-ú0-9]/.test(w)).length
}

/** Strip a trailing compliance footer from a draft body. */
// ---------------------------------------------------------------------------
// Pipeline rows
// ---------------------------------------------------------------------------

/** Push a CRM client into the pipeline. Existing clients keep their row. */
export function addToPipeline(clientId: number): { row: OutreachRow; created: boolean } {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  _dbg(`draft: start ${client.name} (#${clientId}) model=${process.env.OUTREACH_MODEL?.trim() || soulGet("chat_model", "").trim() || "beam-free"}`)
  const existing = row<OutreachRow>("SELECT * FROM pipeline WHERE client_id = ?", [clientId])
  if (existing) return { row: existing, created: false }

  const now = nowISO()
  const result = crmDb().run(
    `INSERT INTO pipeline (client_id, stage, channel, touch, created_at, updated_at)
     VALUES (?, ?, 'email', 0, ?, ?)`,
    [clientId, client.status === "scouted" ? "scouted" : client.status, now, now],
  )
  const created = row<OutreachRow>("SELECT * FROM pipeline WHERE id = ?", [result.lastInsertRowid])
  if (!created) throw new Error("Pipeline insert did not produce a row.")
  return { row: created, created: true }
}

export function listPipeline(filter: { stage?: string; limit?: number } = {}): OutreachRow[] {
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
  if (filter.stage) {
    return rows<OutreachRow>("SELECT * FROM pipeline WHERE stage = ? ORDER BY id LIMIT ?", [
      filter.stage,
      limit,
    ])
  }
  return rows<OutreachRow>("SELECT * FROM pipeline ORDER BY id LIMIT ?", [limit])
}

export function getPipelineRow(id: number): OutreachRow | null {
  return row<OutreachRow>("SELECT * FROM pipeline WHERE id = ?", [id]) ?? null
}

// ---------------------------------------------------------------------------
// Drafts (files the human reads)
// ---------------------------------------------------------------------------

/**
 * Write the next touch as a draft file. The copy comes in from the caller
 * (Elitza writes it); this owns the envelope: recipient, compliance footer,
 * file naming, and the matching pipeline row state.
 */
function sanitizeDraftBody(text: string, lang?: string): string {
  let out = text.replace(/—/g, "-").replace(/–/g, "-")
  // calque fixes
  out = out.replace(/sistemi operativi/gi, "processi interni")
  out = out.replace(/collo di bottiglia/gi, "rallentamento")
  return out
}

export function humanizeField(value: string, lang: "it" | "en" = "en"): string {
  const v = (value || "").toLowerCase().trim()
  const map: Record<string, { it: string; en: string }> = {
    doc_automation: { it: "gestione documenti e contratti", en: "document and contract handling" },
    lead_intake: { it: "raccolta e smistamento richieste", en: "inbound lead intake and routing" },
    crm_ops: { it: "aggiornamento gestionale e contatti", en: "CRM and contact operations" },
    customer_support: { it: "risposte ai clienti e segreteria", en: "client support and front-desk replies" },
    outbound: { it: "ricerca e contatto nuovi clienti", en: "outbound client acquisition" },
    legal: { it: "studi legali", en: "law firms" },
    avvocati: { it: "studi legali", en: "law firms" },
    denti: { it: "studi dentistici e cliniche", en: "dental clinics" },
    dentisti: { it: "studi dentistici e cliniche", en: "dental clinics" },
    commercialisti: { it: "studi commercialisti", en: "accounting firms" },
    idraulici_impianti: { it: "impiantistica e assistenza tecnica", en: "field trades and HVAC" },
  }
  if (map[v]) return lang === "it" ? map[v].it : map[v].en
  return value
}

export function buildOutreachContext(client: any): string {
  if (client?.language !== "it") {
    return "OPENER: friendly, peer-to-peer, first name if known. CTA: low-pressure 15-minute call."
  }
  const addr = String(client?.address || "").toLowerCase()
  const nearby = ["soresina", "crema", "cremona", "pizzighettone", "codogno", "casalpusterlengo", "lodi", "offanengo", "pandino", "soncino", "orzinuovi"]
  if (addr.includes("castelleone")) {
    return 'LOCAL HOOK: informal "tu" ("Ciao [Nome], ti scrivo qui da Castelleone."). CTA: caffè in paese o chiamata di 15 minuti.'
  }
  if (nearby.some((t) => addr.includes(t))) {
    return 'LOCAL HOOK: informal "tu" ("Ciao [Nome], ti scrivo da Castelleone, a pochi minuti da te."). CTA: caffè o chiamata di 15 minuti.'
  }
  return 'LOCAL HOOK: informal "tu" ("Ciao [Nome], ti scrivo da Milano."). CTA: chiamata veloce di 15 minuti.'
}

export function writeDraft(
  clientId: number,
  input: { subject: string; body: string; variant?: string; from?: string },
): { filePath: string; row: OutreachRow } {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  if (!client.email) {
    throw new Error(`No email for ${client.name} — set a verified non-PEC email first.`)
  }
  if (!isSendableOutreachEmail(client.email, { website: client.website, businessName: client.company || client.name })) {
    throw new Error(
      `Blocked outreach email for ${client.name} (${client.email}) — legal/privacy/admin/PEC addresses cannot be drafted.`,
    )
  }

  let subject = input.subject.trim()
  if (!subject) throw new Error("A draft needs both a subject and a body.")

  const { row: pipelineRow } = addToPipeline(clientId)
  const touch = pipelineRow.touch + 1
  if (touch > 4) throw new Error("The 4-touch cadence is already complete for this client.")

  const cleanBodyInput = sanitizeDraftBody(stripFooter(input.body.trim()), client.language)
  const sanitized = validateAndSanitizeDraft({ subject, body: cleanBodyInput }, client, touch)
  subject = sanitized.subject || subject
  const body = sanitized.body
  if (!body) throw new Error("A draft needs a body.")
  const from = resolveSender(input.from)
  const day = nowISO().slice(0, 10)
  const dir = path.join(PIPELINE_DIR, day)
  const filePath = path.join(dir, `C${clientId}-${slug(subject, "draft")}.md`)
  fs.mkdirSync(dir, { recursive: true })

  fs.writeFileSync(filePath, renderDraft(pipelineRow, client.email, from, subject, body, touch, "drafted", input.variant, client.language))
  crmDb().run(
    "UPDATE pipeline SET draft_path = ?, approved = 0, queued_touch = ?, variant = ?, updated_at = ? WHERE id = ?",
    [filePath, touch, input.variant ?? null, nowISO(), pipelineRow.id],
  )
  return { filePath, row: getPipelineRow(pipelineRow.id) ?? pipelineRow }
}

function renderDraft(
  pipelineRow: OutreachRow,
  to: string,
  from: string,
  subject: string,
  body: string,
  touch: number,
  status: string,
  variant?: string,
  language?: string,
): string {
  const lines = [
    "---",
    `pipeline: ${pipelineRow.id}`,
    `client: ${pipelineRow.client_id}`,
    `touch: ${touch}`,
    `to: ${to}`,
    `from: ${from}`,
    `subject: ${subject}`,
    `status: ${status}`,
    `created: ${nowISO()}`,
  ]
  if (variant) lines.push(`variant: ${variant}`)
  lines.push("---")
  return [
    ...lines,
    "",
    body,
    "",
    footer(language),
    "",
  ].join("\n")
}

export function updateDraft(id: number, input: { subject?: string; body?: string }): { filePath: string; row: OutreachRow } {
  const row = getPipelineRow(id)
  if (!row) throw new Error("No pipeline row with id " + id)
  if (!row.draft_path) throw new Error("No draft file for row " + id)
  const client = getClient(row.client_id)
  if (!client) throw new Error("No client for row " + id)
  const filePath = row.draft_path
  let text = ""
  try { text = fs.readFileSync(filePath, "utf8") } catch { throw new Error("Draft file not found: " + filePath) }
  // parse frontmatter
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  const fm = fmMatch ? fmMatch[1] : ""
  const oldBody = fmMatch ? fmMatch[2].trim() : text.trim()
  // extract footer (last block after body). We'll rebuild with new body + original footer.
  // Determine footer from language
  const language = client.language
  // new subject
  let newSubject = input.subject !== undefined ? input.subject.trim() : null
  if (newSubject === null) {
    const m = fm.match(/^subject:\s*(.*)$/m)
    newSubject = m ? m[1].trim() : ""
  }
  let newBody = input.body !== undefined ? input.body.trim() : oldBody
  // strip any existing footer from newBody
  newBody = stripFooter(newBody)
  // sanitize
  const sanitized = validateAndSanitizeDraft({ subject: newSubject, body: newBody }, client)
  newSubject = sanitized.subject || newSubject
  newBody = sanitized.body
  // rebuild file
  const lines = fm.split("\n").map((l) => l.startsWith("subject:") ? `subject: ${newSubject}` : l)
  const newContent = lines.join("\n") + "\n---\n\n" + newBody + "\n\n" + footer(language) + "\n"
  fs.writeFileSync(filePath, newContent)
  return { filePath, row: getPipelineRow(id) ?? row }
}

/** Flip a reviewed draft to sent in place — content stays exactly as approved. */
function markSent(filePath: string, sentAt: string): void {
  const text = fs.readFileSync(filePath, "utf8")
  const withStatus = text.replace(/^status:.*$/m, "status: sent")
  const marked = /^sent_at:/m.test(withStatus)
    ? withStatus.replace(/^sent_at:.*$/m, `sent_at: ${sentAt}`)
    : withStatus.replace(/^status: sent$/m, `status: sent\nsent_at: ${sentAt}`)
  fs.writeFileSync(filePath, marked)
}

/** Read a draft back: the human may have edited to/subject/body. */
export function readDraft(filePath: string): DraftFile | null {
  if (!fs.existsSync(filePath)) return null
  const lines = fs.readFileSync(filePath, "utf8").split("\n")
  if (lines[0]?.trim() !== "---") return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return null
  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const split = line.indexOf(":")
    if (split > 0) meta[line.slice(0, split).trim()] = line.slice(split + 1).trim()
  }
  const postFrontmatter = lines.slice(end + 1).join("\n").trim()
  const client = meta.client ? getClient(Number(meta.client)) : null
  const lang = client?.language === "it" ? "it" : (client?.language === "en" ? "en" : (/Un saluto,\s*\n+Dario Cositore/i.test(postFrontmatter) ? "it" : "en"))
  return {
    to: meta.to ?? "",
    from: meta.from ?? (process.env.RESEND_FROM?.trim() || ""),
    subject: meta.subject ?? "",
    body: stripFooter(postFrontmatter),
    sendText: ensureSignaturePreserved(postFrontmatter, lang),
    touch: Number(meta.touch ?? 1),
  }
}

// ---------------------------------------------------------------------------
// Approval and sending
// ---------------------------------------------------------------------------

/** Batch-approve drafts. Every id must be an approved-pending draft with a file. */
export function approveDrafts(ids: number[]): OutreachRow[] {
  if (!ids.length) throw new Error("Approve needs at least one pipeline id.")
  const approved: OutreachRow[] = []
  for (const id of ids) {
    const pipelineRow = getPipelineRow(id)
    if (!pipelineRow) throw new Error(`No pipeline row with id ${id}.`)
    if (!pipelineRow.draft_path) throw new Error(`Pipeline ${id} has no draft to approve.`)
    crmDb().run("UPDATE pipeline SET approved = 1, updated_at = ? WHERE id = ?", [nowISO(), id])
    approved.push(getPipelineRow(id) ?? pipelineRow)
  }
  return approved
}

export interface SendResult {
  sent: number[]
  failed: { id: number; reason: string }[]
}

/**
 * Send approved drafts through Resend and advance each row through the
 * cadence: touch n sets stage TOUCH_STAGES[n-1] and schedules touch n+1
 * for +3 / +7 / +14 days. Unapproved rows are never sent.
 */
function isLocalResendUrl(): boolean {
  try {
    const u = new URL(resendUrl())
    return u.hostname === "127.0.0.1" || u.hostname === "localhost"
  } catch {
    return false
  }
}

function dailyCap(): number {
  const raw = process.env.OUTREACH_DAILY_CAP
  const n = raw ? Number(raw) : 50
  return Number.isFinite(n) && n > 0 ? n : 50
}

function countSentToday(): number {
  const today = new Date().toISOString().slice(0, 10)
  const kinds = ["first_touch", "followup_1", "followup_2", "followup_3"]
  const placeholders = kinds.map(() => "?").join(",")
  const r = crmDb().query(
    `SELECT COUNT(*) AS c FROM client_interactions WHERE kind IN (${placeholders}) AND occurred_at >= ?`,
  ).get(...kinds, today + "T00:00:00.000Z") as { c: number } | undefined
  return r?.c ?? 0
}

export async function sendApproved(ids?: number[]): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const defaultFrom = process.env.RESEND_FROM?.trim()
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set. Add your own Resend key to ~/.ai-enablement-agent/.env as RESEND_API_KEY=... (mode 600), plus RESEND_FROM=<verified sender>.",
    )
  }
  if (!defaultFrom) throw new Error("RESEND_FROM is not set — the verified sender address Resend accepts (used as fallback when a draft has no from).")

  const targets = ids?.length
    ? rows<OutreachRow>(`SELECT * FROM pipeline WHERE id IN (${ids.map(() => "?").join(",")})`, ids)
    : rows<OutreachRow>("SELECT * FROM pipeline WHERE approved = 1 AND draft_path IS NOT NULL ORDER BY id")

  const result: SendResult = { sent: [], failed: [] }
  let hadSend = false
  for (const pipelineRow of targets) {
    if (pipelineRow.approved !== 1) {
      result.failed.push({ id: pipelineRow.id, reason: "not approved" })
      continue
    }
    // Daily cap guard.
    if (countSentToday() >= dailyCap()) {
      result.failed.push({ id: pipelineRow.id, reason: "daily cap reached" })
      // stop gracefully
      for (const remaining of targets.slice(targets.indexOf(pipelineRow) + 1)) {
        result.failed.push({ id: remaining.id, reason: "daily cap reached" })
      }
      break
    }
    const draft = pipelineRow.draft_path ? readDraft(pipelineRow.draft_path) : null
    if (!draft || !pipelineRow.draft_path) {
      result.failed.push({ id: pipelineRow.id, reason: "draft file missing or unreadable" })
      continue
    }
    const clientForGate = getClient(pipelineRow.client_id)
    if (!EMAIL_ADDRESS.test(draft.to) || !isSendableOutreachEmail(draft.to, { website: clientForGate?.website, businessName: clientForGate?.name })) {
      result.failed.push({ id: pipelineRow.id, reason: `recipient blocked by email routing gate (${draft.to || "empty"})` })
      continue
    }

    if (hadSend && !isLocalResendUrl()) {
      const delay = 1500 + Math.floor(Math.random() * 1501)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    const from = resolveSender(draft.from) || defaultFrom
    const failure = await sendEmail(from, draft.to, draft.subject, draft.sendText)
    if (failure) {
      result.failed.push({ id: pipelineRow.id, reason: failure })
      continue
    }

    const sentAt = nowISO()
    const touch = pipelineRow.touch + 1
    const stage = TOUCH_STAGES[touch - 1] ?? pipelineRow.stage
    const dueIn = CADENCE_DAYS[touch - 1]
    const nextTouchAt = dueIn
      ? new Date(Date.parse(sentAt) + dueIn * 86_400_000).toISOString()
      : null
    crmDb().run(
      `UPDATE pipeline SET touch = ?, stage = ?, approved = 0, queued_touch = 0, last_touch_at = ?, next_touch_at = ?, updated_at = ?
       WHERE id = ?`,
      [touch, stage, sentAt, nextTouchAt, sentAt, pipelineRow.id],
    )
    updateClient(pipelineRow.client_id, { ...(stageExists(stage) ? { status: stage } : {}), last_contact: sentAt })
    logInteraction(pipelineRow.client_id, {
      kind: touch === 1 ? "first_touch" : `followup_${touch - 1}`,
      direction: "out",
      channel: "email",
      status: "sent",
      subject: draft.subject,
      body: draft.sendText,
      occurred_at: sentAt,
    })
    markSent(pipelineRow.draft_path, sentAt)
    result.sent.push(pipelineRow.id)
    hadSend = true
  }
  return result
}

/** One Resend call. Returns a failure reason, or null when it went out. */
async function sendEmail(from: string, to: string, subject: string, text: string): Promise<string | null> {
  try {
    const response = await fetch(resendUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY?.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      return `Resend HTTP ${response.status}: ${detail}`
    }
    return null
  } catch (error) {
    return String(error)
  }
}

// ---------------------------------------------------------------------------
// Cadence scheduler (Task E)
// ---------------------------------------------------------------------------

/** Stages where the cadence has stopped one way or another (Task F owns them). */
const TERMINAL_STAGES = ["yes", "no", "stale", "done"]

/** Copy for touch n+1 — shorter each time, always in the same thread. */
const FOLLOWUP_BODIES: Record<number, string> = {
  2: "Following up on my previous note — still worth a short conversation this week?",
  3: "One more nudge on the same. Happy to send a one-page outline instead, if judging it in writing is easier.",
  4: "Last one from me: if this is not a priority I will leave it alone. Reply and I will pick it back up.",
}

/** Italian follow-up copy (natural, not translated). */
const FOLLOWUP_BODIES_IT: Record<number, string> = {
  2: "Riprendo il messaggio precedente, vale ancora la pena sentirci per una breve chiamata questa settimana?",
  3: "Un altro promemoria sullo stesso tema. Se preferisci, posso inviarti un sintetico di una pagina da leggere.",
  4: "Ultimo messaggio da parte mia: se non è una priorità adesso, lascio perdere. Rispondi e riprendo quando vuoi.",
}

/** Rows whose next touch is due now: cadence still running, nothing waiting for review. */
export function listDue(now = nowISO(), limit = 20): OutreachRow[] {
  return rows<OutreachRow>(
    `SELECT * FROM pipeline
       WHERE next_touch_at IS NOT NULL
         AND next_touch_at <= ?
         AND touch < 4
         AND queued_touch <= touch
         AND stage NOT IN (${TERMINAL_STAGES.map(() => "?").join(",")})
       ORDER BY next_touch_at
       LIMIT ?`,
    [now, ...TERMINAL_STAGES, limit],
  )
}

export interface FollowupQueue {
  queued: { pipeline_id: number; client_id: number; touch: number; path: string }[]
  skipped: { pipeline_id: number; reason: string }[]
}

/**
 * The scheduler pass: draft every due follow-up as a file waiting for the
 * same batch review as a first touch. It never sends — approval stays the
 * human's, and `queued_touch` keeps the same follow-up from being drafted
 * twice on the next tick.
 */
export function queueFollowups(now = nowISO()): FollowupQueue {
  const result: FollowupQueue = { queued: [], skipped: [] }
  for (const pipelineRow of listDue(now)) {
    const client = getClient(pipelineRow.client_id)
    if (!client) {
      result.skipped.push({ pipeline_id: pipelineRow.id, reason: "client row missing" })
      continue
    }
    // Stop follow-ups when an inbound reply exists after last_touch_at.
    const lastTouch = pipelineRow.last_touch_at
    if (lastTouch) {
      const inboundEmails = rows<{ c: number }>("SELECT COUNT(*) AS c FROM emails WHERE folder = 'inbox' AND direction = 'in' AND client_id = ? AND occurred_at > ?", [pipelineRow.client_id, lastTouch])
      const inboundInteractions = rows<{ c: number }>("SELECT COUNT(*) AS c FROM client_interactions WHERE direction = 'in' AND kind IN ('email_received','reply') AND client_id = ? AND occurred_at > ?", [pipelineRow.client_id, lastTouch])
      if ((inboundEmails[0]?.c ?? 0) > 0 || (inboundInteractions[0]?.c ?? 0) > 0) {
        result.skipped.push({ pipeline_id: pipelineRow.id, reason: "inbound reply detected after last touch" })
        continue
      }
    }
    try {
      const { filePath, row } = writeDraft(pipelineRow.client_id, followupCopy(pipelineRow, client.name, client.language))
      result.queued.push({
        pipeline_id: row.id,
        client_id: row.client_id,
        touch: row.queued_touch,
        path: filePath,
      })
    } catch (error) {
      result.skipped.push({ pipeline_id: pipelineRow.id, reason: String(error) })
    }
  }
  return result
}

/**
 * Copy for touch n+1: `Re:` the subject that was actually sent, so a reply
 * lands in the thread the recipient already has. No sent subject means no
 * thread to stay in — one plain line instead.
 */
export function followupCopy(pipelineRow: OutreachRow, business: string, language?: string): { subject: string; body: string } {
  const isIt = language === "it"
  const bodies = isIt ? FOLLOWUP_BODIES_IT : FOLLOWUP_BODIES
  const previous = pipelineRow.draft_path ? readDraft(pipelineRow.draft_path) : null
  const topic = previous?.subject.replace(/^\s*re:\s*/i, "").trim() ?? ""
  const line = bodies[pipelineRow.touch + 1] ?? bodies[2]
  const fallbackSubject = isIt ? `${business}: vale una breve chiamata?` : `${business}: still worth a conversation?`
  return topic
    ? { subject: `Re: ${topic}`, body: line }
    : { subject: fallbackSubject, body: line }
}

// ---------------------------------------------------------------------------
// Disposition (Task F)
// ---------------------------------------------------------------------------

/** What a conversation ends as: interested, rejected, or silent. */
export type Verdict = "yes" | "no" | "stale"

/** Where the client lives afterwards: production, or the nurture list. */
const VERDICT_CLIENT_STATUS: Record<Verdict, string> = {
  yes: "diagnose",
  no: "stale",
  stale: "stale",
}

/**
 * Close a conversation. Every verdict stops the cadence the same way —
 * next touch cancelled, nothing left approved, any waiting draft de-queued —
 * and the client is moved: `yes` enters the work production pipeline at
 * `diagnose`, `no` and `stale` both land in the stale list that feeds the
 * newsletter and nurture. The verdict itself is kept on the pipeline row.
 */
export function dispose(
  id: number,
  verdict: string,
  note?: string,
): { row: OutreachRow; client_status: string } {
  const pipelineRow = getPipelineRow(id)
  if (!pipelineRow) throw new Error(`No pipeline row with id ${id}.`)
  const clientStatus = VERDICT_CLIENT_STATUS[verdict as Verdict]
  if (!clientStatus) throw new Error(`Unknown verdict "${verdict}". Use yes, no or stale.`)

  const now = nowISO()
  crmDb().run(
    `UPDATE pipeline SET stage = ?, next_touch_at = NULL, approved = 0, queued_touch = 0, updated_at = ?
     WHERE id = ?`,
    [verdict, now, id],
  )
  updateClient(pipelineRow.client_id, { ...(stageExists(clientStatus) ? { status: clientStatus } : {}) })
  logInteraction(pipelineRow.client_id, {
    kind: "disposition",
    direction: "in",
    channel: "note",
    status: verdict,
    subject: `disposition: ${verdict}`,
    body: note ?? "",
    occurred_at: now,
  })
  return { row: getPipelineRow(id) ?? pipelineRow, client_status: clientStatus }
}

/**
 * The silent end of the cadence: four touches went out, nothing came back,
 * so the row joins the stale list. Runs from the same heartbeat pass as the
 * scheduler, and on demand. Rows already disposed are left alone.
 */
export function variantStats(): { variant: string | null; sent: number; replied: number; conversion: number }[] {
  const rows = crmDb().query(
    `SELECT p.variant AS variant, c.status AS status, COUNT(*) AS n
     FROM pipeline p JOIN clients c ON c.id = p.client_id
     WHERE p.variant IS NOT NULL
     GROUP BY p.variant, c.status`,
  ).all() as { variant: string; status: string; n: number }[]
  const byVariant = new Map<string, { sent: number; replied: number }>()
  for (const r of rows) {
    const v = r.variant ?? "(none)"
    const cur = byVariant.get(v) ?? { sent: 0, replied: 0 }
    cur.sent += r.n
    if (r.status === "yes" || r.status === "done" || r.status === "payment" || r.status === "scheduled") cur.replied += r.n
    byVariant.set(v, cur)
  }
  return [...byVariant.entries()].map(([variant, d]) => ({ variant, sent: d.sent, replied: d.replied, conversion: d.sent ? d.replied / d.sent : 0 }))
}

export function sweepExhausted(now = nowISO()): OutreachRow[] {
  const exhausted = rows<OutreachRow>(
    `SELECT * FROM pipeline
       WHERE touch >= 4
         AND next_touch_at IS NULL
         AND stage NOT IN (${TERMINAL_STAGES.map(() => "?").join(",")})
       ORDER BY id`,
    TERMINAL_STAGES,
  )
  for (const pipelineRow of exhausted) {
    crmDb().run(
      "UPDATE pipeline SET stage = 'stale', approved = 0, queued_touch = 0, updated_at = ? WHERE id = ?",
      [now, pipelineRow.id],
    )
    updateClient(pipelineRow.client_id, { ...(stageExists("stale") ? { status: "stale" } : {}) })
    logInteraction(pipelineRow.client_id, {
      kind: "cadence_exhausted",
      direction: "note",
      channel: "note",
      status: "stale",
      subject: "4 touches, no reply",
      occurred_at: now,
    })
    debugSweep(pipelineRow.id)
  }
  return exhausted
}

function debugSweep(id: number): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    fs.appendFileSync("/tmp/elitza-brain-debug.log", `${new Date().toISOString()} outreach: sweep ${id} -> stale\n`)
  } catch {
    // Logging is best-effort.
  }
}

// ---------------------------------------------------------------------------
// generateClientOutreachDraft + validateAndSanitizeDraft (high-volume drafting)
// ---------------------------------------------------------------------------

const BANNED_IT_AUTO: [RegExp, string][] = [
  [/flussi/gi, "processi"],
  [/flusso/gi, "processo"],
  [/collo di bottiglia/gi, "rallentamento"],
  [/sistemi operativi/gi, "processi interni"],
  [/senza soluzione di continuità/gi, "in modo diretto"],
  [/Tuttavia/g, "Ma"],
]

const BANNED_IT_VOCAB = ["panorama","ecosistema","sfruttare","promuovere","favorire","robusto","dinamico","immersivo","esplorare","immergersi","all'avanguardia","a 360 gradi","collo di bottiglia","sistemi operativi","senza soluzione di continuità"]
const BANNED_EN_VOCAB = ["delve","foster","utilize","leverage","underscore","navigate","resonate","paramount","pivotal","seamless","robust","dynamic","multifaceted","tapestry","beacon","compass","symphony","landscape","catalyst","testament","unlock","unleash","supercharge"]

async function resolveOpenCodeAuth(): Promise<{ key: string; orgId: string }> {
  let apiKey = process.env.OPENCODE_API_KEY?.trim() || ""
  let orgId = ""
  if (apiKey) return { key: apiKey, orgId }
  try {
    const Database = (await import("bun:sqlite")).default
    const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
    const db = new (Database as any)(dbPath, { readonly: true })
    const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
    if (row?.value) {
      const cred = JSON.parse(row.value)
      if (cred.access) apiKey = cred.access
      if (cred.metadata?.orgID) orgId = cred.metadata.orgID
    }
    db.close()
  } catch { /* ignore */ }
  return { key: apiKey, orgId }
}


function isBusinessName(name: string): boolean {
  const n = (name || "").trim()
  if (!n) return false
  const bizTokens = ["Studio", "Dental", "Clinica", "Centro", "Srl", "Snc", "Sas", "Spa", "Officina", "Impianti", "Agenzia", "Termoidraulica"]
  if (bizTokens.some((t) => new RegExp("\\b" + t + "\\b", "i").test(n))) return true
  const words = n.split(/\s+/).filter(Boolean)
  if (words.length > 2) return true
  // Italian first names are typically single capitalized word; if both words capitalized and no clear first name, treat as business
  if (words.length === 2 && words.every((w) => /^[A-Z]/.test(w))) {
    // heuristic: common Italian first names
    const firstNames = new Set(["Marco","Luca","Paolo","Andrea","Matteo","Davide","Alessandro","Francesco","Giovanni","Antonio","Roberto","Stefano","Fabio","Simone","Daniele","Enrico","Giuseppe","Massimo","Riccardo","Alberto","Lorenzo","Filippo","Nicola","Claudio","Michele","Sergio","Pietro","Tommaso","Federico","Emanuele","Giorgio","Carlo","Matteo","Domenico"])
    if (!firstNames.has(words[0])) return true
  }
  return false
}

const IT_TOUCH1_HARD_BANS: { label: string; re: RegExp }[] = [
  { label: "English uppercase AI", re: /\b(?:AI|A\.I\.)\b/ },
  { label: "em-dash or en-dash", re: /[—–]/ },
  { label: "semicolon", re: /;/ },
  { label: "price leak in Touch 1", re: /(?:€|\$|\bEUR\b|\bUSD\b|prezzo\s+fisso|\b(?:150|400|490|1\.?500|2\.?500|3\.?500)\s*(?:euro|€)?\b)/i },
  { label: "banned word flusso/flussi", re: /\bfluss[oi]\b/i },
  { label: "banned phrase collo di bottiglia", re: /collo\s+di\s+bottiglia/i },
  { label: "banned phrase sistemi operativi", re: /sistemi\s+operativi/i },
  { label: "banned phrase senza soluzione di continuità", re: /senza\s+soluzione\s+di\s+continuit[àa]/i },
  { label: "banned LLM vocab", re: /\b(?:panorama|ecosistema|sfruttare|promuovere|favorire|robusto|dinamico|immersivo|all'avanguardia|inoltre|tuttavia|in\s+definitiva)\b/i },
  { label: "hyperbole scommetto che / ore preziose", re: /scommetto\s+che|ore\s+preziose/i },
  { label: "coffee CTA", re: /\bcaff[èe]\b/i },
  { label: "mail-merge third-person site trap", re: /sono\s+passato\s+sul\s+sito|sul\s+sito\s+(?:di|dello|della|del)\b/i },
  { label: "passive browsing/city opener", re: /stavo\s+(?:lavorando|guardando)|ti\s+scrivo\s+(?:qui\s+)?da\s+/i },
  { label: "wrong pivot phrasing", re: /se\s+invece\s+non\s+fosse\s+cos[ìi]/i },
  { label: "trivial hook", re: /\bsabato\b|due\s+numeri|due\s+email|indirizzo\s+email|tante\s+prestazioni/i },
]

export interface Touch1ValidationResult {
  ok: boolean
  word_count: number
  issues: string[]
}

export function validateTouch1Draft(
  draft: { subject: string; body: string },
  lang: "it" | "en" = "it",
): Touch1ValidationResult {
  const bodyOnly = stripFooter(draft.body.trim())
  const subject = draft.subject.trim()
  // Word count measures the 4-beat body excluding the fixed LOCKED_IT_PIVOT suffix.
  const bodyForCount = bodyOnly.endsWith(LOCKED_IT_PIVOT)
    ? bodyOnly.slice(0, bodyOnly.length - LOCKED_IT_PIVOT.length).trim()
    : bodyOnly
  const wc = countWords(bodyForCount)
  const issues: string[] = []

  if (!subject) issues.push("empty subject")
  if (/[:"]|[—–]/.test(subject)) issues.push("subject contains colon, quotes, or dash")
  if (countWords(subject) > 8) issues.push(`subject too long (${countWords(subject)} words)`)
  if (/\{\{[^}]+\}\}|\b(?:doc_automation|lead_intake|crm_ops|customer_support|scout_y)\b/.test(`${subject} ${bodyOnly}`)) {
    issues.push("leaked template variable or snake_case enum")
  }

  if (lang === "it") {
    if (wc < 85 || wc > 125) issues.push(`word_count_out_of_bounds:${wc} (expected 85-125 excluding signature/P.S.)`)
    if (!/^(?:Buongiorno|Ciao\s+[A-ZÀ-Ú][a-zà-ú'-]+),\s+una\s+domanda\s+diretta:/m.test(bodyOnly)) {
      issues.push("Beat 1 must open with 'Buongiorno, una domanda diretta:' or 'Ciao [Nome], una domanda diretta:'")
    }
    if (!bodyOnly.includes("?")) issues.push("Beat 1 missing question mark")
    if (!/Te lo chiedo perché/.test(bodyOnly)) issues.push("Beat 2 missing 'Te lo chiedo perché'")
    if (!/\bAssistenti personali IA\b/.test(bodyOnly)) issues.push("Beat 3 missing 'Assistenti personali IA'")
    if (!bodyOnly.endsWith(LOCKED_IT_PIVOT)) issues.push("Beat 4 does not match verbatim LOCKED_IT_PIVOT")

    for (const rule of IT_TOUCH1_HARD_BANS) {
      if (rule.re.test(subject) || rule.re.test(bodyOnly)) {
        issues.push(rule.label)
      }
    }
  } else {
    if (wc < 65 || wc > 125) issues.push(`word_count_out_of_bounds:${wc}`)
    if (/[€]|\bEUR\b/.test(`${subject} ${bodyOnly}`)) issues.push("EUR leaked into English Touch 1")
    if (/\$|\bUSD\b/.test(`${subject} ${bodyOnly}`)) issues.push("price leaked into Touch 1")
  }

  return { ok: issues.length === 0, word_count: wc, issues }
}

export function validateAndSanitizeDraft(input: any, client?: any, touch = 1): any {
  const lang = (client?.language === "it") ? "it" : (client?.language === "en" ? "en" : "en")
  const isStr = typeof input === "string"
  let subject = isStr ? "" : String(input?.subject ?? "")
  let body = isStr ? String(input) : String(input?.body ?? "")
  const issues: string[] = []
  // Greeting guardrail: business names get "Buongiorno," not "Ciao <name>,"
  if (client?.name && isBusinessName(client.name)) {
    const escaped = client.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    body = body.replace(new RegExp("Ciao\\s+" + escaped + "\\s*,", "gi"), "Buongiorno,")
    subject = subject.replace(new RegExp("Ciao\\s+" + escaped + "\\s*,", "gi"), "Buongiorno,")
  }

  // strip unreplaced template vars
  if (/\{\{[^}]+\}\}/.test(subject + body)) {
    subject = subject.replace(/\{\{[^}]+\}\}/g, "")
    body = body.replace(/\{\{[^}]+\}\}/g, "")
    issues.push("unreplaced template variables stripped")
  }

  if (lang === "it") {
    for (const [re, rep] of BANNED_IT_AUTO) {
      body = body.replace(re, rep)
      subject = subject.replace(re, rep)
    }
    // Normalize standalone English "AI" -> "IA" in Italian copy.
    if (/\bAI\b/.test(body) || /\bAI\b/.test(subject)) {
      body = body.replace(/\bAI\b/g, "IA")
      subject = subject.replace(/\bAI\b/g, "IA")
      issues.push("AI normalized to IA")
    }
    // Normalize robotic SKU labels.
    body = body.replace(/audit operativo locale/gi, "audit operativo al volo")
    subject = subject.replace(/audit operativo locale/gi, "audit operativo al volo")
    const isMedical = /dentist|denti|medic|clinic|fisio/i.test(String(client?.vertical ?? ""))
    if (isMedical) {
      body = body.replace(/voci CRM/gi, "schede in gestionale")
      subject = subject.replace(/voci CRM/gi, "schede in gestionale")
    }
    for (const w of BANNED_IT_VOCAB) {
      if ((body + " " + subject).toLowerCase().includes(w.toLowerCase())) issues.push(`banned term: ${w}`)
    }
    for (const re of BANNED_TRIVIAL_HOOKS) {
      if (re.test(body + " " + subject)) issues.push(`trivial hook: ${re.source}`)
    }
  } else {
    for (const w of BANNED_EN_VOCAB) {
      if ((body + " " + subject).toLowerCase().includes(w.toLowerCase())) issues.push(`banned term: ${w}`)
    }
  }

  // currency check for english
  if (lang === "en") {
    if (body.includes("€") || body.includes("EUR") || subject.includes("€") || subject.includes("EUR")) {
      body = body.replace(/€/g, "$").replace(/EUR/g, "USD")
      subject = subject.replace(/€/g, "$").replace(/EUR/g, "USD")
      issues.push("currency normalized to USD")
    }
  }

  // reject unreplaced enum keys
  const enumKeys = ["doc_automation","lead_intake","crm_ops","customer_support","scout_y"]
  for (const ek of enumKeys) {
    if ((body + " " + subject).includes(ek)) {
      issues.push("enum key leaked: " + ek)
      const human = humanizeField(ek, lang as "it" | "en")
      body = body.split(ek).join(human)
      subject = subject.split(ek).join(human)
    }
  }
  // verify client name
  if (client?.name) {
    const cleaned = cleanDisplayName(String(client.name))
    if (!(body.includes(client.name) || body.includes(cleaned) || subject.includes(client.name) || subject.includes(cleaned))) {
      issues.push("client name not referenced")
    }
  }
  // local hook is no longer auto-prepended; the model is responsible for it.

  const ok = issues.length === 0
  if (isStr) return body
  return { ok, subject, body, issues }
}

const FEW_SHOT_BY_TRACK: Record<string, string> = {
  it_local_audit_150: `Example:\n{"subject":"Due chiacchiere su Termoidraulica Rossi","body":"Ciao Marco,\\n\\nti scrivo qui da Castelleone. Stavo lavorando con alcuni studi della zona sulla gestione delle richieste di segreteria e sono passato sul sito di Termoidraulica Rossi.\\n\\nHo notato che sul sito avete un modulo contatti e una sezione preventivi con tempi di risposta indicati.\\n\\nQuando si lavora su più cantieri come fate voi, con chiamate urgenti e preventivi da chiudere, scommetto che tenere allineati telefono, email, WhatsApp e agende porta via tantissime ore preziose praticamente ogni settimana.\\n\\nLavoro con aziende che vogliono togliere il lavoro ripetitivo tra email, telefono, WhatsApp e documentazione. La maggior parte di loro mi chiede di implementare Assistenti personali IA che leggono le richieste in arrivo, le qualificano e preparano i preventivi, sempre con conferma umana prima di ogni invio.\\n\\nMagari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, faccio un audit operativo a prezzo fisso (€150) senza stravolgere nulla. Ti va una chiamata di 15 minuti questa settimana?"}`,

  it_local_micro_490: `Example:\n{"subject":"Richieste dal sito - Studio Dentistico Bianchi","body":"Ciao Andrea,\\n\\nti scrivo da Castelleone, a pochi minuti da te. Stavo lavorando con alcuni studi dentistici della zona sulla gestione delle richieste di segreteria e sono passato sul sito di Studio Dentistico Bianchi.\\n\\nHo notato che sul sito avete un modulo contatti e gli orari della segreteria con prenotazione online.\\n\\nQuando si lavora su due ambulatori come fate voi, con appuntamenti urgenti, scommetto che tenere allineati telefono, email, WhatsApp e agende porta via tantissime ore preziose praticamente ogni settimana.\\n\\nLavoro con studi che vogliono togliere il lavoro ripetitivo tra email, telefono, WhatsApp e documentazione. La maggior parte di loro mi chiede di implementare Assistenti personali IA che rispondono subito via email o WhatsApp, raccolgono i dati del paziente e li passano alla segreteria pronti per la conferma, sempre con approvazione umana.\\n\\nMagari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, lavoro a prezzo fisso (€490), consegno in 3 giorni e il sistema resta al 100% tuo, senza stravolgere nulla. Ti va di sentirci 15 minuti questa settimana?"}`,

  it_pmi_diagnosi_400: `Example:\n{"subject":"Una domanda veloce su Studio Conti","body":"Ciao Marco,\\n\\nti scrivo da Milano. Stavo lavorando con alcuni studi strutturati sulla gestione delle richieste e sono passato sul sito di Studio Conti.\\n\\nHo notato che sul sito avete sia contabilità ordinaria che consulenza del lavoro, con contatti diretti via email e telefono.\\n\\nQuando si lavora su più aree di pratica come fate voi, con email, PEC e gestionale da allineare, scommetto che tenere tutto aggiornato porta via tantissime ore preziose praticamente ogni settimana.\\n\\nLavoro con studi che vogliono togliere il lavoro ripetitivo tra email, telefono, WhatsApp e documentazione. La maggior parte di loro mi chiede di implementare Assistenti personali IA che leggono le richieste in arrivo, le qualificano e preparano le bozze di risposta, sempre con conferma umana prima di ogni invio.\\n\\nMagari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, faccio una diagnosi operativa a prezzo fisso (€400) senza stravolgere nulla. Ti va di fare due chiacchiere di 15 minuti questa settimana?"}`,

  it_pmi_track1_1500: `Example:\n{"subject":"Una domanda veloce su Officine Verdi","body":"Ciao Paolo,\\n\\nti scrivo da Milano. Stavo lavorando con alcune officine sulla gestione delle richieste tecniche e sono passato sul sito di Officine Verdi.\\n\\nHo notato che sul sito avete un modulo per le richieste tecniche con campi per servizio e sede.\\n\\nQuando si lavora su più cantieri come fate voi, con richieste da smistare e preventivi da chiudere, scommetto che tenere allineati email, moduli e gestionale porta via tantissime ore preziose praticamente ogni settimana.\\n\\nLavoro con aziende che vogliono togliere il lavoro ripetitivo tra email, telefono, WhatsApp e documentazione. La maggior parte di loro mi chiede di implementare Assistenti personali IA che leggono le richieste, le qualificano e preparano le bozze, così il team non deve copiare dati a mano ogni giorno, sempre con conferma umana.\\n\\nMagari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, costruisco gli Agenti Operativi IA di Proprietà a prezzo fisso (€1.500), in pochi giorni, senza stravolgere nulla. Ti va una chiamata di 15 minuti questa settimana?"}`,

  it_pmi_track1_2500: `Example:\n{"subject":"Modulo preventivi su Agenzia Nord","body":"Ciao Luca,\\n\\nti scrivo da Milano. Stavo lavorando con alcune agenzie sulla gestione dei preventivi e sono passato sul sito di Agenzia Nord.\\n\\nHo notato che sul sito avete un modulo preventivi ben strutturato per servizio e sede.\\n\\nQuando si lavora su più sedi come fate voi, con richieste da smistare e preventivi da chiudere, scommetto che tenere allineati moduli, CRM e referenti porta via tantissime ore preziose praticamente ogni settimana.\\n\\nLavoro con aziende che vogliono togliere il lavoro ripetitivo tra email, telefono, WhatsApp e documentazione. La maggior parte di loro mi chiede di implementare Assistenti personali IA che leggono le richieste, le qualificano e preparano le bozze di risposta, così arrivano già ordinate al referente giusto in pochi secondi, sempre con conferma umana prima di ogni invio.\\n\\nMagari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, costruisco gli Agenti Operativi IA di Proprietà a prezzo fisso (€2.500), in pochi giorni, senza stravolgere nulla. Ti va una chiamata veloce di 15 minuti questa settimana?"}`,

  it_pmi_track1_3500: `Example:\n{"subject":"Gestione documenti - Studio Pirri","body":"Ciao Luca,\\n\\nti scrivo da Milano. Stavo lavorando con alcuni studi legali sulla gestione dei documenti e sono passato sul sito di Studio Pirri.\\n\\nHo notato che sul sito avete più aree del diritto con contatti diretti via email e telefono.\\n\\nQuando si lavora su più aree di pratica come fate voi, con documenti e richieste in entrata da smistare, scommetto che tenere tutto allineato porta via tantissime ore preziose praticamente ogni settimana.\\n\\nLavoro con studi che vogliono togliere il lavoro manuale su documenti e richieste in entrata. La maggior parte di loro mi chiede di implementare Assistenti personali IA che leggono email e PDF, qualificano i lead e preparano le bozze, sempre con conferma umana prima di ogni invio: per uno studio di 30 persone ho portato la sincronizzazione nel gestionale a 10 secondi (+45% conversioni qualificate).\\n\\nMagari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, lavoro a prezzo fisso (€3.500), consegno in pochi giorni e il sistema resta al 100% vostro, senza stravolgere nulla. Ti va di sentirci 15 minuti questa settimana?"}`,

  en_discovery_0: `Example:\n{"subject":"Quick question about Northstar Accounting","body":"Hi Mark,\\n\\nI took a look at Northstar Accounting's site and saw you handle both tax prep and advisory for small businesses.\\n\\nI help teams like yours take repetitive admin off their plate with Owned AI Agents that read incoming email and documents, qualify leads, and prepare drafts your team approves before anything sends. I don't know how you're handling it today, you might already have a great setup.\\n\\nIf you're ever curious what's actually worth automating without disrupting how your team works, I'm happy to jump on a free 15-minute call.\\n\\nWorth a quick chat this week?"}`,

  en_track1_4000: `Example:\n{"subject":"Quote form on Apex Mechanical","body":"Hi David,\\n\\nI saw the service request form on Apex Mechanical's site - nice and clear for commercial jobs.\\n\\nI build Owned AI Systems that connect forms like yours straight to your CRM: an AI agent reads each inquiry, qualifies the lead, and prepares the CRM entry and quote draft, with your team's approval before anything sends.\\n\\nI work at a fixed price ($4,000), deliver in days, and you own 100% of the code on your own infrastructure.\\n\\nIf that sounds like something that could save your team a few hours a week, open to a quick 15-minute call?"}`,
}

function _dbg(m: string){ const a=(globalThis as any).__debugLogs; if (Array.isArray(a)) a.push({ts:new Date().toISOString(),msg:m}); }
function cleanDisplayName(name: string): string {
  let n = (name || "").trim()
  // Strip trailing academic/professional prefixes like "DR.", "DR.SSA.", "DOTT.".
  n = n.replace(/\bDR\.?\s*SSA\.?\b/gi, "").replace(/\bDOTT\.?\s*SSA\.?\b/gi, "").replace(/\bDR\.?\b/gi, "").replace(/\bDOTT\.?\b/gi, "").trim()
  n = n.replace(/\s+/g, " ").trim()
  // Title-case all-caps or dotty names.
  if (n.length > 0 && n === n.toUpperCase()) {
    n = n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return n || (name || "").trim()
}

const BANNED_TRIVIAL_HOOKS: RegExp[] = [/sabato/i, /due numeri/i, /due email/i, /indirizzo email/i, /tante prestazioni/i]

function hasTrivialHook(text: string): boolean {
  return BANNED_TRIVIAL_HOOKS.some((re) => re.test(text || ""))
}

export async function generateClientOutreachDraft(clientId: number): Promise<{ subject: string; body: string; filePath?: string; row?: any; skipped?: string }> {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)

  // Enrichment gate: skip drafting when signal is too thin to support a real
  // operational observation.
  const hasSignal = !!(client.notes && client.notes.trim().length >= 80) || !!(client.website && client.website.trim())
  if (!hasSignal) {
    return { subject: "", body: "", filePath: undefined, row: undefined, skipped: "insufficient_enrichment_signal" }
  }

  const routed = routeClientTrack(client)
  const offerTrack = client.offer_track || routed.track

  const { key: apiKey, orgId } = await resolveOpenCodeAuth()
  if (!apiKey) throw new Error("OpenCode Go key not configured.")

  const systemPrompt = `You are Dario Cositore extracting 4 JSON slots for an Italian cold email. Output ONLY a single compact JSON object with no markdown or extra text:
{"contact_first_name":"...","subject":"...","observation_sentence":"...","bridge_sentence":"..."}

Why these 4 slots exist (predictive first-touch logic):
A busy owner, partner, or local operator reads a cold email with skepticism and silently asks:
- "Is this relevant to us?" -> clear, specific subject line.
- "Did you actually look at how we operate, or is this a blast?" -> observation_sentence citing one real operational signal from the input.
- "Why should we care? What is the actual problem?" -> bridge_sentence must NOT just name a task and claim it takes time. Use the 3-step arc:
  1) Respect their current setup ("come fate voi" + real coordination/attention effort).
  2) Point out a concrete, believable operational snag caused by that setup (such as duplicate contacts saved across channels, scattered notes/follow-ups, or mixed-up threads).
  3) Tie manual handling to weekly time drain ("Scommetto che gestire il tutto in modo manuale, vi porta via tantissime ore preziose praticamente ogni settimana.").
- "Are you going to push a hard sales pitch on me?" -> keep tone calm, observant, and non-pushy.

Rules:
1. contact_first_name: Extract a real human first name ONLY if clearly present as a person's name in client.name, client.notes, or client.email (e.g. info@paolabarbini.com -> "Paola"). Return "" if only a company, studio, shop, or generic inbox exists.
2. subject: Short Italian subject line (no colons, no quotes, max 7 words). Reference the business or one concrete operational detail without repeating the exact wording of observation_sentence.
3. observation_sentence: One neutral Italian sentence starting with "Ho notato che..." (max 18 words) describing ONE real operational complexity signal supported by Website, Business summary, or Tech stack: multiple locations/branches, online booking or quote/intake forms combined with phone/WhatsApp/email triage, urgent or multi-step intake, or recurring documents/quotes.
   - If input data is sparse or vague, anchor strictly to the clearest confirmed detail without inventing facts or tools.
   - Match vocabulary strictly to Vertical and actual facts: use "clienti", "pratiche", "consulenze" for legal/consulting/business services; use "pazienti", "visite" only when the business is medical/dental/health.
   - Always use plural "voi" ("seguite", "gestite", "raccogliete").
   - Hard bans: no "@" or email addresses, no phone numbers, no HTML title lists, no negative/critical words ("generico", "solo", "manca", "vecchio", "problema", "errore"), no "sabato", no raw phone/email counts ("due numeri", "due email", "indirizzo email"), no "tante prestazioni", no "AI" (use "IA"), no em-dashes ("—") or en-dashes ("–").
4. bridge_sentence: One or two conversational Italian sentences (max 34 words total) following the 3-step "why should we care" arc above, including "come fate voi", a concrete snag, "scommetto che", and "porta via tantissime ore preziose praticamente ogni settimana" (prefer "porta via" over "vi costa").
   - Never repeat the business name or any town name already stated in observation_sentence.
   - Never use semicolons (;) or mix singular "tu" with plural "voi".
   - Write in plain, natural spoken Italian with correct spelling/accents ("coordinazione", "più") and no banned words ("flusso", "flussi", "collo di bottiglia", "senza soluzione di continuità", "robusto", "dinamico", "inoltre", "tuttavia").

Output ONLY the JSON object, no markdown, no explanation.`

  const userPrompt = `Client: ${client.name}
Vertical: ${client.vertical ?? "unknown"}
Language: ${client.language ?? "en"}
Address: ${client.address ?? "unknown"}
Website: ${client.website ?? "none"}
Business summary: ${client.notes ?? ""}
Tech stack: ${client.tech_stack ?? ""}
Pain category: ${client.pain_category ?? ""}

Output ONLY the JSON object {"contact_first_name":"...","subject":"...","observation_sentence":"...","bridge_sentence":"..."}.`

  const baseUrl = "https://opencode.ai/inference/go/openai/v1"
  const model = process.env.OUTREACH_MODEL?.trim() || soulGet("chat_model", "").trim() || "beam-free"

  async function call(effort: string, userPromptOverride?: string): Promise<any> {
    const up = userPromptOverride || userPrompt
    const res = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "x-opencode-session": "elitza-draft-" + Date.now(), "x-opencode-org-id": orgId },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: up }],
        stream: false,
        max_tokens: 4096,
        reasoning_effort: effort,
      }),
    })
    if (!res.ok) { const detail = await res.text().catch(() => ""); throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`) }
    return res.json()
  }

  let data: any
  try {
    data = await call("medium")
  } catch {
    data = await call("low")
  }
  let msg = data?.choices?.[0]?.message
  let content = msg?.content || ""
  if (!content.trim()) {
    const rc = msg?.reasoning_content || ""
    const m = rc.match(/\{[\s\S]*\}/)
    if (m) content = m[0]
  }
  if (!content.trim()) {
    try {
      data = await call("low")
      msg = data?.choices?.[0]?.message
      content = msg?.content || ""
      if (!content.trim()) {
        const rc = msg?.reasoning_content || ""
        const m = rc.match(/\{[\s\S]*\}/)
        if (m) content = m[0]
      }
    } catch { /* ignore */ }
  }

  let contactFirstName = ""
  let subject = ""
  let observationSentence = ""
  let bridgeSentence = ""
  try {
    const parsed = JSON.parse(content)
    contactFirstName = String(parsed.contact_first_name ?? "").trim()
    subject = String(parsed.subject ?? "").trim()
    observationSentence = String(parsed.observation_sentence ?? "").trim()
    bridgeSentence = String(parsed.bridge_sentence ?? "").trim()
  } catch {
    const m = content.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const parsed = JSON.parse(m[0])
        contactFirstName = String(parsed.contact_first_name ?? "").trim()
        subject = String(parsed.subject ?? "").trim()
        observationSentence = String(parsed.observation_sentence ?? "").trim()
        bridgeSentence = String(parsed.bridge_sentence ?? "").trim()
      } catch { /* ignore */ }
    }
  }

  // Retry once with a stronger instruction if slots are empty or a trivial hook slipped through.
  const slotsEmpty = !observationSentence || !bridgeSentence || !subject
  if (slotsEmpty || hasTrivialHook(observationSentence) || hasTrivialHook(bridgeSentence)) {
    try {
      const retryPrompt = userPrompt + "\\n\\nIMPORTANT: avoid trivial hooks (no sabato, no phone/email counts, no tante prestazioni). Anchor observation and bridge to a real operational complexity signal (multiple locations, booking/quote forms with triage, urgent intake, or recurring documents). Follow the 3-step bridge arc and use 'porta via tantissime ore preziose praticamente ogni settimana'."
      const data2 = await call("low", retryPrompt)
      let msg2 = data2?.choices?.[0]?.message
      let content2 = msg2?.content || ""
      if (!content2.trim()) {
        const rc2 = msg2?.reasoning_content || ""
        const m2 = rc2.match(/\\{[\\s\\S]*\\}/)
        if (m2) content2 = m2[0]
      }
      const parsed2 = JSON.parse(content2)
      contactFirstName = String(parsed2.contact_first_name ?? contactFirstName).trim()
      subject = String(parsed2.subject ?? subject).trim()
      observationSentence = String(parsed2.observation_sentence ?? observationSentence).trim()
      bridgeSentence = String(parsed2.bridge_sentence ?? bridgeSentence).trim()
    } catch { /* keep first attempt */ }
  }

  // Strip accidental email addresses from observation sentence.
  observationSentence = observationSentence.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "").replace(/@/g, "").trim()

  // Hook-quality gate: if a trivial hook survives the retry, replace it with a
  // clean generic observation so a draft still lands in the approval queue.
  if (hasTrivialHook(observationSentence) || hasTrivialHook(bridgeSentence)) {
    observationSentence = "Ho notato che sul sito presentate i vostri servizi e i canali di contatto."
    bridgeSentence = "Quando si lavora come fate voi, con richieste da gestire e follow-up da fare, scommetto che tenere tutto allineato porta via tantissime ore preziose praticamente ogni settimana."
  }
  // Fallback: if the LLM produced empty slots, build a minimal valid pair so a
  // draft still lands in the approval queue for the operator to personalize.
  if (!subject || !observationSentence || !bridgeSentence) {
    const fallbackName = cleanDisplayName(String(client.name || ""))
    if (!subject) subject = (fallbackName || "la vostra attività") + ": una domanda veloce"
    if (!observationSentence) observationSentence = "Ho notato che sul sito presentate i vostri servizi e i canali di contatto."
    if (!bridgeSentence) bridgeSentence = "Quando si lavora come fate voi, con richieste da gestire e follow-up da fare, scommetto che tenere tutto allineato porta via tantissime ore preziose praticamente ogni settimana."
  }

  // Assemble Italian email body deterministically (Hybrid Slot Assembly).
  const isMedical = /dentist|denti|medic|clinic|fisio|studio/i.test(`${client.vertical ?? ""} ${client.name ?? ""} ${client.notes ?? ""}`)
  const group = isMedical ? "studi" : "aziende"
  const subjectNoun = isMedical ? "dei pazienti" : "dei clienti"

  const greeting = contactFirstName ? "Ciao " + contactFirstName + "," : "Buongiorno,"

  const addr = String(client.address || "").toLowerCase()
  const nearby = ["crema", "cremona", "soresina", "lodi", "codogno", "pizzighettone", "offanengo", "pandino", "soncino", "orzinuovi"]
  const displayName = cleanDisplayName(String(client.name || ""))
  let beat1: string
  if (addr.includes("castelleone")) {
    beat1 = `ti scrivo qui da Castelleone. Stavo lavorando con alcuni ${group} della zona sulla gestione delle richieste ${subjectNoun} e sono passato sul sito di ${displayName}.`
  } else if (nearby.some((t) => addr.includes(t))) {
    beat1 = `ti scrivo da Castelleone, a pochi minuti da te. Stavo lavorando con alcuni ${group} della zona sulla gestione delle richieste ${subjectNoun} e sono passato sul sito di ${displayName}.`
  } else {
    beat1 = `ti scrivo da Milano. Stavo lavorando con alcuni ${group} sulla gestione delle richieste in entrata e sono passato sul sito di ${displayName}.`
  }

  const beat4 = `Lavoro con ${group} che vogliono togliere il lavoro ripetitivo tra email, telefono, WhatsApp e documentazione. La maggior parte di loro mi chiede di implementare Assistenti personali IA che leggono le richieste ${subjectNoun} in arrivo, le smistano, preparano bozze di preventivo e organizzano il calendario.`

  const isLocalLead = /castelleone|borghetto lodigiano|crema|cremona|soresina|lodi|codogno|pizzighettone|offanengo|pandino|soncino|orzinuovi/i.test(addr)
  const beat5Track = (isLocalLead && offerTrack !== "it_local_micro_490" && !String(offerTrack).startsWith("it_pmi_track1_")) ? "it_local_audit_150" : offerTrack
  let beat5: string
  if (beat5Track === "it_local_audit_150") {
    beat5 = "Non so come gestisci oggi queste attività, magari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, facciamo un audit operativo al volo (€150) per capire dove è possibile risparmiare tempo senza stravolgere nulla. Fammi sapere se ti va di sentirci 15 minuti questa settimana."
  } else if (beat5Track === "it_local_micro_490") {
    beat5 = "Non so come gestisci oggi queste attività, magari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, installo il sistema completo a prezzo fisso (€490, poi €49/mese opzionali di assistenza) senza stravolgere nulla. Fammi sapere se ti va di sentirci 15 minuti questa settimana."
  } else if (beat5Track === "it_pmi_diagnosi_400") {
    beat5 = "Non so come gestisci oggi queste attività, magari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, facciamo una diagnosi operativa a prezzo fisso (€400) per capire dove risparmiare tempo senza stravolgere nulla. Fammi sapere se ti va di sentirci 15 minuti questa settimana."
  } else if (beat5Track === "it_pmi_track1_1500") {
    beat5 = "Non so come gestisci oggi queste attività, magari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, costruisco gli Agenti Operativi IA di Proprietà a prezzo fisso (€1.500), in pochi giorni, senza stravolgere nulla. Fammi sapere se ti va di sentirci 15 minuti questa settimana."
  } else if (beat5Track === "it_pmi_track1_2500") {
    beat5 = "Non so come gestisci oggi queste attività, magari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, costruisco gli Agenti Operativi IA di Proprietà a prezzo fisso (€2.500), in pochi giorni, senza stravolgere nulla. Fammi sapere se ti va di sentirci 15 minuti questa settimana."
  } else if (beat5Track === "it_pmi_track1_3500") {
    beat5 = "Non so come gestisci oggi queste attività, magari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, costruisco gli Agenti Operativi IA di Proprietà a prezzo fisso (€3.500), in pochi giorni, senza stravolgere nulla. Fammi sapere se ti va di sentirci 15 minuti questa settimana."
  } else {
    beat5 = "Non so come gestisci oggi queste attività, magari hai già tutto sotto controllo. Se invece non fosse così e hai la curiosità di saperne di più sull'IA e le sue capacità reali nel tuo contesto specifico, facciamo una diagnosi operativa a prezzo fisso (€400) per capire dove risparmiare tempo senza stravolgere nulla. Fammi sapere se ti va di sentirci 15 minuti questa settimana."
  }

  let body = [greeting, "", beat1, "", observationSentence, "", bridgeSentence, "", beat4, "", beat5].join("\n")

  const sanitized = validateAndSanitizeDraft({ subject, body }, client)
  subject = sanitized.subject
  body = sanitized.body

  if (!body) {
    return { subject, body: "", filePath: undefined, row: undefined, skipped: "empty_after_sanitize" }
  }

  let filePath: string | undefined
  let row: any
  try {
    const r = writeDraft(clientId, { subject, body })
    filePath = r.filePath
    row = r.row
  } catch (e) { console.error("[outreach] writeDraft error:", String(e)) }

  return { subject, body, filePath, row }
}