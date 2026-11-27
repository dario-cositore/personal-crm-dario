/**
 * Elitza CRM "house" — a zero-build, single-page web dashboard over the CRM.
 *
 * Exposes `startCrmView()` which binds an HTTP server (default port 8800,
 * override with CRM_VIEW_PORT) serving a JSON API + an embedded HTML
 * dashboard. Reuses the exact same brain modules as the TUI, so there is no
 * second source of truth. Returns a cleanup function that stops the server.
 *
 * The plugin calls this from its setup hook so the house comes up whenever
 * the engine (elitza serve) starts and goes down when it stops.
 */

import { addClient, findClients, countClients, getClient, updateClient, listInteractions, listAssets, listCompanies, crmDb, saveScoutRun, listScoutRuns, getScoutRun, deleteScoutRun, listSegments, getSegment, saveSegment, updateSegment, deleteSegment, countSegmentMembers, listSegmentMembers, listEmails, getEmail, createEmail, updateEmail, deleteEmail, moveEmail, emailCounts, findClientByEmail, logInteraction, logAudit } from "./crm.js"
import { scoutBusinesses } from "./scouting.js"
import { enrichClient } from "./enrichment.js"
import { classifyEmailCandidate, isSendableOutreachEmail } from "./email_gate.js"
import { addToPipeline, writeDraft } from "./outreach.js"
import { makeBrainTools } from "./tools.js"
import { approveDrafts, sendApproved, listPipeline } from "./outreach.js"
import { advance, recordPayment, scheduleCall, productionState } from "./production.js"
import { seedPlaybooks } from "./playbooks.js"

// Load ~/.ai-enablement-agent/.env (mode 600) into process.env, like the elitza launcher does.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
try {
  const envPath = join(homedir(), ".ai-enablement-agent", ".env")
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
} catch {
  // No .env — continue with whatever the shell provides.
}

const DEFAULT_STAGES = [
  { id: "scouted", label: "Scouted", color: "#62666d", statusColor: "muted" },
  { id: "manual_check", label: "Manual Checks", color: "#f2c94c", statusColor: "warn" },
  { id: "draft_ready", label: "Draft Ready", color: "#4ea7fc", statusColor: "info" },
  { id: "not_enough_info", label: "Not Enough Info", color: "#f2c94c", statusColor: "warn" },
  { id: "enriched", label: "Enriched", color: "#c44b32", statusColor: "accent" },
  { id: "contacted", label: "Contacted", color: "#4ea7fc", statusColor: "info" },
  { id: "followup_1", label: "Follow-up 1", color: "#4ea7fc", statusColor: "info" },
  { id: "followup_2", label: "Follow-up 2", color: "#4ea7fc", statusColor: "info" },
  { id: "followup_3", label: "Follow-up 3", color: "#4ea7fc", statusColor: "info" },
  { id: "yes", label: "Won", color: "#27a644", statusColor: "ok" },
  { id: "no", label: "Lost", color: "#eb5757", statusColor: "err" },
  { id: "stale", label: "Stale", color: "#f2c94c", statusColor: "warn" },
  { id: "diagnose", label: "Diagnose", color: "#c44b32", statusColor: "accent" },
  { id: "proposal", label: "Proposal", color: "#c44b32", statusColor: "accent" },
  { id: "workbook", label: "Workbook", color: "#c44b32", statusColor: "accent" },
  { id: "scheduled", label: "Scheduled", color: "#f2c94c", statusColor: "warn" },
  { id: "payment", label: "Payment", color: "#27a644", statusColor: "ok" },
  { id: "done", label: "Done", color: "#27a644", statusColor: "ok" },
]
const STATUSES = DEFAULT_STAGES.map(s => s.id)

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}

// Guardrail: refuse to share internal instructions/details or tool inventories.
function guardrailReply(text: string): string | null {
  const t = (text || "").toLowerCase()
  if (!t.trim()) return null
  const sensitive = [
    "instruction", "system prompt", "your prompt", "prompting", "guardrail",
    "persona", "soul", "internal", "how are you built", "how were you made",
    "your code", "source code", "training", "reveal", "show me your", "share your",
  ]
  if (sensitive.some((k) => t.includes(k))) {
    return "I can't share that. I'm your AI Enablement Agent — I handle scouting, CRM, outreach, enrichment, and delivery. How can I help with your clients?"
  }
  const cap = [
    "what can you do", "what do you do", "your capabilities", "your tools", "what tools",
    "list your tools", "what are your tools", "your api", "what api", "what features",
    "what functions", "what commands", "how do you work", "what do you know",
  ]
  if (cap.some((k) => t.includes(k))) {
    return "I'm your AI Enablement Agent. I help you scout local clients, qualify them in a CRM, enrich leads, run outreach cadence, and deliver implementation sprints. I don't share my internal tooling or implementation details. What would you like to do with your clients?"
  }
  return null
}

async function readBody(req: Request): Promise<any> {
  try { return await req.json() } catch { return {} }
}

async function runEnginePrompt(prompt: string, timeoutMs = 120000): Promise<string> {
  // Resolve live engine
  let url = process.env.ELITZA_ENGINE_URL || ""
  let password = process.env.ELITZA_ENGINE_PASSWORD || ""
  let live = false
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const os = await import("node:os")
    const home = process.env.HOME || os.homedir()
    const cfgPath = path.join(home, ".local", "state", "opencode", "service.json")
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
    if (cfg.pid) { try { process.kill(cfg.pid, 0) } catch { throw new Error("stale service") } }
    if (cfg.url) { url = cfg.url; live = true }
    if (cfg.password) password = cfg.password
  } catch { /* no live engine */ }
  if (process.env.ELITZA_ENGINE_URL) url = process.env.ELITZA_ENGINE_URL
  if (!live && !process.env.ELITZA_ENGINE_URL) {
    // Fall back to direct provider call (no skills, but keeps working)
    const { directChat } = await import("./crmview.js").catch(() => ({} as any))
    // directChat not exported; do a minimal direct call via soul/env instead
  }
  if (!url) throw new Error("No live agent engine. Start 'elitza serve' first.")
  const auth = "Basic " + Buffer.from(":" + password).toString("base64")
  const headers: any = { "Content-Type": "application/json", "Authorization": auth }
  const createRes = await fetch(url + "/session", { method: "POST", headers, body: JSON.stringify({ title: "Strategy generation" }) })
  if (!createRes.ok) throw new Error("session create failed: " + createRes.status)
  const session = await createRes.json() as any
  const sid = session.id
  await fetch(url + "/session/" + sid + "/prompt", { method: "POST", headers, body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }) })
  // Poll for assistant reply
  const deadline = Date.now() + timeoutMs
  let reply = ""
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const msgRes = await fetch(url + "/session/" + sid + "/message", { headers })
      const msgs = await msgRes.json() as any[]
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.info?.role !== "assistant") continue
        const text = (m.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
        if (text && text.trim()) { reply = text; break }
      }
      if (reply) break
    } catch { /* keep polling */ }
  }
  if (!reply) throw new Error("Strategy generation timed out or produced no output.")
  return reply
}

function buildStrategyPrompt(product: any): string {
  const priceLine = product.price != null ? `${product.currency || "USD"} ${product.price}` : "Free"
  return `You are the AI Enablement Agent's strategy engine. Generate a COMPLETE, deterministic go-to-market and execution strategy for the following product. Apply your agent skills (copywriting, pricing, cold-email, ads, content-strategy, sales-enablement, offers, positioning) where relevant.

PRODUCT DATA:
- Name: ${product.name}
- Type: ${product.type}
- Price: ${priceLine}
- Description: ${product.description || "(none)"}
- Audience: ${product.audience || "(unspecified)"}
- Deliverable: ${product.deliverable || "(unspecified)"}
- URL: ${product.url || "(none)"}
- Notes: ${product.notes || "(none)"}

OUTPUT FORMAT (strict — output ONLY the markdown document below, no preamble, no commentary, no code fences, no reasoning. Your very first characters must be "# Strategy:"):

# Strategy: ${product.name}

## 1. Product snapshot
- Name, type, price, audience, deliverable (one line each)

## 2. Positioning
- Value proposition (one sentence)
- The problem it solves
- Why now

## 3. Ideal customer profile (ICP)
- Who buys (target buyer, role, company size)
- Pain points (3 bullets)
- Budget signal
- Where they hang out (channels/communities)

## 4. Offer & pricing
- Price rationale
- Tiering / upsell / downsell
- Guarantee / risk reversal

## 5. Go-to-market channels
- Primary channel (with why)
- Secondary channel
- Content-led channel

## 6. Messaging & hooks
- 3 hooks (short)
- 3 subject lines
- Primary CTA

## 7. Sales process
- Lead -> qualified -> proposal -> close (steps with owner + timeline)
- Objection handling (top 3 objections + replies)

## 8. 30-day content plan
- 4 content pieces (title + channel + goal)

## 9. KPIs & success metrics
- 3 metrics with 30-day targets

## 10. Risks & mitigations
- 3 risks with mitigations

## 11. Next 3 actions
- Concrete, owner-assigned, dated next steps

Rules: be specific to THIS product. No generic advice. No placeholders. Markdown only.`
}

async function generateProductStrategy(product: any): Promise<string> {
  const prompt = buildStrategyPrompt(product)
  return await runEnginePrompt(prompt, 120000)
}


async function proxyChatToEngine(text: string): Promise<string> {
  // Read engine URL/password from service config or env.
  // Skip proxying if no live engine is available (stale service.json).
  let liveEngine = false
  let url = ""
  let password = process.env.ELITZA_ENGINE_PASSWORD || ""
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const os = await import("node:os")
    const home = process.env.HOME || os.homedir()
    const cfgPath = path.join(home, ".local", "state", "opencode", "service.json")
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
    if (cfg.pid) {
      try { process.kill(cfg.pid, 0) } catch { throw new Error("stale service") }
    }
    if (cfg.url) { url = cfg.url; liveEngine = true }
    if (cfg.password) password = cfg.password
  } catch { /* no live engine */ }
  if (!liveEngine) return "(no response)"
  if (process.env.ELITZA_ENGINE_URL) url = process.env.ELITZA_ENGINE_URL
  const auth = "Basic " + Buffer.from(":" + password).toString("base64")
  const headers: any = { "Content-Type": "application/json", "Authorization": auth }
  // Create session
  const createRes = await fetch(url + "/session", { method: "POST", headers, body: JSON.stringify({ title: "CRM chat" }) })
  const session = await createRes.json() as any
  const sid = session.id
  // Send prompt
  await fetch(url + "/session/" + sid + "/prompt", { method: "POST", headers, body: JSON.stringify({ parts: [{ type: "text", text }] }) })
  // Wait for generation
  await new Promise((r) => setTimeout(r, 3000))
  // Read messages
  const msgRes = await fetch(url + "/session/" + sid + "/message", { headers })
  const msgs = await msgRes.json() as any[]
  let reply = ""
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.info?.role !== "assistant") continue
    reply = (m.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
    break
  }
  return reply || "(no response)"
}


async function directChat(text: string, provider?: "opencode-go", modelOverride?: string, variantOverride?: string): Promise<{ thinking: string; reply: string }> {
  const refusal = guardrailReply(text)
  if (refusal) return { thinking: "", reply: refusal }
  // Read provider/model from soul if not explicitly passed.
  if (!provider) {
    try {
      const { soulGet } = await import("./soul.js")
      provider = "opencode-go"
    } catch {
      provider = "opencode-go"
    }
  }
  // Standalone fallback: call the configured provider directly with SOUL.md as system prompt.
  let apiKey = ""
  let baseUrl = ""
  let model = "beam-free"
  let variant = ""
  let soul = ""
  let home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (process.env.HOME || "") + "/.ai-enablement-agent"
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const os = await import("node:os")
    home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (process.env.HOME || os.homedir()) + "/.ai-enablement-agent"
    const envPath = path.join(home, ".env")
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq < 0) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (k === "OPENCODE_API_KEY" && !apiKey) apiKey = v
    }
    const soulPath = path.join(home, "SOUL.md")
    try { soul = fs.readFileSync(soulPath, "utf8").slice(0, 800) } catch {}
  } catch { /* ignore */ }

    // Resolve the OpenCode Go plan credential from Elitza's own store (never from another OpenCode).
    if (!apiKey) {
      try {
        const Database = (await import("bun:sqlite")).default
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
        const db = new Database(dbPath, { readonly: true })
        const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
        if (row?.value) {
          const cred = JSON.parse(row.value)
          if (cred.access) apiKey = cred.access
        }
        db.close()
      } catch { /* ignore */ }
    }
    baseUrl = "https://opencode.ai/inference/go/openai/v1"
    model = modelOverride || "beam-free"
    try {
      const { soulGet } = await import("./soul.js")
      const saved = soulGet("chat_model", "")
      if (saved && !modelOverride) model = saved
      const savedVariant = soulGet("chat_variant", "")
      if (savedVariant && !variantOverride) variant = savedVariant
      if (variantOverride) variant = variantOverride
    } catch {}
  if (!apiKey) return { thinking: "", reply: "Not connected to OpenCode Go. Open CRM Settings → OpenCode Go plan → Connect / Reconnect." }
  // Expose ALL brain tools to the model so Elitza can touch every aspect of the CRM.
  const brainTools = makeBrainTools({ generate: { text: async (input: { prompt: string }) => ({ data: { text: "" } }) } })
  const tools = brainTools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input },
  }))
  const toolByName = new Map(brainTools.map((t) => [t.name, t]))
  async function runTool(name: string, args: any): Promise<string> {
    const t = toolByName.get(name)
    if (!t) return "unknown tool: " + name
    try {
      const res = await t.execute(args ?? {})
      return typeof res?.content === "string" ? res.content : JSON.stringify(res?.content ?? res)
    } catch (e) { return "error: " + String(e) }
  }

  const messages: any[] = []
  const ctxNote = "\\n\\nSource rule: 'internal client' = a client stored in the CRM (use crm search/get). 'External' = scout results or web research not yet in the CRM. When asked about an internal client, search the CRM first and return the stored record."
  if (soul) messages.push({ role: "system", content: soul + "\\n\\nYou have access to CRM tools. Use them to act on the user's requests. Confirm actions taken. For greetings or small talk, reply directly without calling tools." + ctxNote })
  messages.push({ role: "user", content: text })

  let thinking = ""
  // tool-calling loop (omit tools on final pass so the model must answer in text)
  for (let iter = 0; iter < 4; iter++) {
    const isLast = iter === 3
    const body: any = { model: model, messages, stream: false, max_tokens: 8192 }
    if (variant) body.reasoning_effort = variant
    if (!isLast) body.tools = tools
    const fetchHeaders: Record<string, string> = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey }
    if (provider === "opencode-go") {
      // Read org ID from the opencode console credential.
      try {
        const Database = (await import("bun:sqlite")).default
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
        const db = new Database(dbPath, { readonly: true })
        const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
        if (row?.value) {
          const cred = JSON.parse(row.value)
          if (cred.metadata?.orgID) fetchHeaders["x-opencode-org-id"] = cred.metadata.orgID
        }
        db.close()
      } catch { /* ignore */ }
      fetchHeaders["x-opencode-session"] = "elitza-crm-" + Date.now()
    }
    const res = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify(body),
    })
    const data = await res.json() as any
    const msg = data?.choices?.[0]?.message
    if (!msg) return { thinking, reply: "(no response)" }
    if (msg.reasoning_content) {
      thinking += (thinking ? "\n\n" : "") + msg.reasoning_content
    }
    messages.push(msg)
    const toolCalls = msg.tool_calls
    if (!toolCalls || !toolCalls.length) {
      return { thinking, reply: msg.content || msg.reasoning_content || "(no response)" }
    }
    for (const tc of toolCalls) {
      thinking += (thinking ? "\n" : "") + "→ calling " + tc.function.name + "(" + (tc.function.arguments || "") + ")"
      const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments
      const result = await runTool(tc.function.name, args)
      messages.push({ role: "tool", tool_call_id: tc.id, content: result })
    }
  }
  return { thinking, reply: "(no response)" }
}

async function refreshGmailToken(account: any): Promise<string | null> {
  if (!account?.refresh_token) return null
  const fs = await import("node:fs")
  const pathMod = await import("node:path")
  const os = await import("node:os")
  const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
  let env: Record<string, string> = {}
  try { for (const line of fs.readFileSync(pathMod.join(home, ".env"), "utf8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue; env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim() } } catch {}
  const clientId = env["GOOGLE_CLIENT_ID"]
  const clientSecret = env["GOOGLE_CLIENT_SECRET"]
  if (!clientId || !clientSecret) return null
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refresh_token, client_id: clientId, client_secret: clientSecret }).toString(),
    })
    if (!r.ok) return null
    const j = await r.json() as any
    if (!j.access_token) return null
    const { crmDb } = await import("./crm.js")
    crmDb().run("UPDATE cloud_accounts SET access_token = ?, last_error = NULL, status = 'connected' WHERE id = ?", [j.access_token, account.id])
    return j.access_token
  } catch { return null }
}

// In-memory enrichment progress store (per client).
const enrichJobs = new Map<number, { lines: string[]; running: boolean; done: boolean; error?: string; result?: any }>()
const autopilotJobs = new Map<number, { lines: string[]; running: boolean; done: boolean; error?: string; result?: any }>()
const debugJobs = new Map<string, { type: string; id: string; lines: string[]; running: boolean; done: boolean; error?: string; result?: any }>()
const debugLogs: { ts: string; msg: string }[] = (globalThis as any).__debugLogs = (globalThis as any).__debugLogs || []
function dbg(msg: string) { debugLogs.push({ ts: new Date().toISOString(), msg }); if (debugLogs.length > 500) debugLogs.shift() }
// In-memory Scout X job store.
const scoutXJobs = new Map<string, { lines: string[]; running: boolean; done: boolean; error?: string; result?: any }>()

function productSubject(product: string, name: string, location: string, price: string): string {
  const map: Record<string, string> = {
    "intake-diagnostic": price + " — client intake diagnostic for " + (name || "your business"),
    "lead-list": price + " — " + (location ? location.split(",")[0] : "local") + " " + "lead list (50 verified contacts)",
    "prompt-pack": price + " — AI prompt pack for " + (name || "your team"),
    "email-seq": price + " — cold email sequence for " + (name || "your business"),
    "copy-pack": price + " — website copy rewrite",
    "audit": price + " — AI workflow audit",
  }
  return map[product] || (price + " — " + product)
}

function productBody(product: string, client: any, location: string, price: string, paymentLink: string): string {
  const name = client?.name || "there"
  const place = location ? location.split(",")[0].trim() : "your area"
  const link = paymentLink ? "\\nPay here: " + paymentLink + "\\n" : "\\n(Reply 'yes' and I'll send a payment link.)\\n"
  const templates: Record<string, string> = {
    "intake-diagnostic": "Hi " + name + ",\\n\\nI took a quick look at how " + (client?.vertical || "your business") + " handles client intake and communication. Most small businesses lose 20-40% of inbound leads because intake is manual, slow, or inconsistent (forms, emails, phone calls all in different places, no follow-up).\\n\\nI can deliver a 1-page intake diagnostic for " + (client?.vertical || "your business") + ": what's breaking, where leads drop, and a concrete 3-step fix — no calls needed, delivered as a doc you can read in 5 minutes.\\n\\nPrice: " + price + ".\\n" + link + "\\nIf it's not useful, reply 'no' and you'll never hear from me again.\\n\\n— AI Enablement Agent",
    "lead-list": "Hi " + name + ",\\n\\nI put together a list of 50 " + (client?.vertical || "local") + " businesses in " + place + " with verified emails and phone numbers — ready to paste into your outbound tool.\\n\\nIf you're doing cold outreach, this saves a few hours of manual research. The full list (CSV) is " + price + ".\\n" + link + "\\nDelivered instantly by email. Reply 'no' and you'll never hear from me again.\\n\\n— AI Enablement Agent",
    "prompt-pack": "Hi " + name + ",\\n\\nI have a ready-to-use AI prompt pack tailored for " + (client?.vertical || "your industry") + " — 50+ prompts for emails, proposals, research, and client comms.\\n\\nPrice: " + price + ".\\n" + link + "\\nDelivered instantly. Reply 'no' to opt out.\\n\\n— AI Enablement Agent",
    "email-seq": "Hi " + name + ",\\n\\nI can write you a complete 4-email outbound sequence (first touch + 3 follow-ups) with subject lines and personalization hooks, tailored to " + (client?.vertical || "your niche") + ".\\n\\nPrice: " + price + ".\\n" + link + "\\nDelivered as a doc within 24h. Reply 'no' to opt out.\\n\\n— AI Enablement Agent",
    "copy-pack": "Hi " + name + ",\\n\\nI'll rewrite your homepage + 3 key pages with conversion-focused copy, tailored to " + (client?.vertical || "your business") + ".\\n\\nPrice: " + price + ".\\n" + link + "\\nDelivered as a doc. Reply 'no' to opt out.\\n\\n— AI Enablement Agent",
    "audit": "Hi " + name + ",\\n\\nI'll audit your workflows and deliver a prioritized automation roadmap (what to automate, in what order, with expected ROI) — no calls needed, delivered as a doc + async Loom.\\n\\nPrice: " + price + ".\\n" + link + "\\nReply 'no' to opt out.\\n\\n— AI Enablement Agent",
  }
  return templates[product] || ("Hi " + name + ",\\n\\nI have a " + product + " available for " + price + ".\\n" + link + "\\nReply 'no' to opt out.\\n\\n— AI Enablement Agent")
}

function buildProductReport(product: string, client: any): string {
  const name = client?.name || "your business"
  const diag = client?.notes || "No diagnosis available yet. Run enrichment first."
  const risk = client?.risk_level ? client.risk_level + (client.risk_score ? " (" + client.risk_score + "/100)" : "") : "unknown"
  const tech = client?.tech_stack || "unknown"
  const revenue = client?.revenue_estimate || "unknown"
  const employees = client?.employee_count || "unknown"
  const next = client?.next_action || "Review and decide next step."
  const title = product === "intake-diagnostic" ? "Client Intake Diagnostic" : product.replace(/-/g, " ").replace(/\\b\\w/g, (c) => c.toUpperCase())
  return "<!doctype html><html><head><meta charset='utf-8'><title>" + title + "</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.6}h1{font-size:22px;margin-bottom:4px}h2{font-size:15px;margin-top:24px;border-bottom:1px solid #eee;padding-bottom:4px}p{margin:8px 0}.field{margin:6px 0}.label{font-weight:600;color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.5px}.value{font-size:14px}.pre{white-space:pre-wrap;background:#f7f7f7;padding:12px;border-radius:8px;font-size:13px;border:1px solid #eee}</style></head><body>"
    + "<h1>" + title + "</h1>"
    + "<p style='color:#666;font-size:13px'>Prepared for " + name + " · " + new Date().toISOString().slice(0,10) + "</p>"
    + "<h2>Diagnosis</h2><div class='pre'>" + diag.replace(/</g, "&lt;") + "</div>"
    + "<h2>Risk assessment</h2><div class='field'><span class='label'>Risk level</span><div class='value'>" + risk + "</div></div>"
    + (client?.risk_notes ? "<div class='field'><span class='label'>Notes</span><div class='value'>" + client.risk_notes + "</div></div>" : "")
    + "<h2>Firmographics</h2>"
    + "<div class='field'><span class='label'>Tech stack</span><div class='value'>" + tech + "</div></div>"
    + "<div class='field'><span class='label'>Revenue estimate</span><div class='value'>" + revenue + "</div></div>"
    + "<div class='field'><span class='label'>Employee count</span><div class='value'>" + employees + "</div></div>"
    + "<h2>Recommended next action</h2><p>" + next + "</p>"
    + "<hr style='margin-top:32px;border:none;border-top:1px solid #eee'>"
    + "<p style='font-size:11px;color:#999'>Generated by AI Enablement Agent · " + name + " · Reply to this email with questions.</p>"
    + "</body></html>"
}

export function startCrmView(ctx?: any): { stop: () => void; port: number } | null {
  try { seedPlaybooks() } catch {}
  const PORT = Number(process.env.CRM_VIEW_PORT ?? 8800)
  let chatSessionId: string | null = null
  let strategySessionId: string | null = null
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    const CRM_VIEW_HOST = process.env.CRM_VIEW_HOST || "127.0.0.1"
    server = Bun.serve({
      hostname: CRM_VIEW_HOST,
      port: PORT,
      idleTimeout: 255,
      async fetch(req, server) {
        const url = new URL(req.url)
        const path = url.pathname

        // Public tunnel boundary: only the Tower callback is exposed externally.
        const host = (req.headers.get("host") || "").toLowerCase()
        if (host === "crm-hook.dariocositore.com" && path !== "/api/tower/callback") {
          return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } })
        }

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type,Authorization" } })
        }

        // Optional bearer-token gate for sensitive endpoints.
        const token = process.env.CRM_VIEW_TOKEN?.trim()
        if (token && (path.startsWith("/api/settings/") || path === "/api/settings" || path === "/api/send" || path === "/api/asset")) {
          const auth = req.headers.get("authorization") || ""
          if (auth !== `Bearer ${token}`) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
          }
        }

        // WebSocket upgrade for Ask Elitza chat
        if (path === "/ws/chat") {
          const wsUrl = new URL(req.url)
          const sid = wsUrl.searchParams.get("session")
          const upgraded = server.upgrade(req, { data: { sessionId: sid ? Number(sid) : null } })
          if (upgraded) return undefined as any
          return new Response("WebSocket upgrade failed", { status: 400 })
        }

        if (path === "/api/setup" && req.method === "POST") {
          const body = await readBody(req)
          const answers = body.answers || {}
          const { adoptAnswers, deriveGates, applyGates, applyProvider, writePersona, hardenSecretFiles, loadEnvFile, alignPlanToKey } = await import("./onboarding.js")
          const { soulSet } = await import("./soul.js")
          const { memoryCreate } = await import("./memory.js")
          const { nowISO } = await import("./db.js")
          const state = adoptAnswers(answers)
          // alignPlanToKey if mimo_key provided
          if (answers.mimo_key) {
            // handled inside adoptAnswers already for secret; re-align just in case
          }
          const personaPath = writePersona(state) ?? ""
          const gates = applyGates(deriveGates(answers.ask_first ?? ""))
          const providerNote = applyProvider(answers.mimo_plan ?? "")
          const hardened = hardenSecretFiles()
          soulSet("user_name", answers.human ?? "")
          soulSet("role", answers.role ?? "")
          soulSet("style", answers.voice ?? "")
          soulSet("initiative", answers.initiative ?? "")
          soulSet("hard_rules", answers.never ?? "")
          soulSet("permission_gates", answers.ask_first ?? "")
          soulSet("memory_policy", answers.memory ?? "")
          soulSet("provider", "mimo")
          soulSet("mimo_key", answers.mimo_key === "(saved, mode 600)" ? "set" : "not set")
          soulSet("maton_key", answers.maton_key === "(saved, mode 600)" ? "set" : "not set")
          soulSet("onboarding_completed", state.completed ?? nowISO())
          try {
            memoryCreate(
              `Setup with ${answers.human ?? "my person"}: my name is ${answers.name ?? "AI Enablement Agent"}, I am ${answers.role ?? "a companion"}, I talk ${answers.voice ?? "directly"}, my initiative is ${answers.initiative ?? "balanced"}. Hard rules: ${answers.never ?? "none"}. I ask first about: ${answers.ask_first ?? "nothing"}.`,
              { memoryType: "semantic", importance: 0.9, tags: ["setup", "identity"] },
            )
          } catch {}
          return json({ ok: true, personaPath, gates, providerNote, hardened })
        }
        if (path === "/api/setup/status" && req.method === "GET") {
          const { isComplete } = await import("./onboarding.js")
          return json({ complete: isComplete() })
        }
        if (path === "/api/settings" && req.method === "GET") {
          const { soulGet } = await import("./soul.js")
          const { getActiveVertical, listVerticals } = await import("./verticals.js")
          const { costSummary } = await import("./crm.js")
          const { engineConfigPath } = await import("./configview.js")
          let gates: any = {}
          try { const fs = await import("node:fs"); gates = JSON.parse(fs.readFileSync(engineConfigPath(), "utf8")) } catch {}
          let heartbeatError = ""
          try { heartbeatError = soulGet("heartbeat_last_error", "") } catch {}
          return json({
            provider: soulGet("chat_provider", process.env.ELITZA_CHAT_PROVIDER || "opencode-go"),
            model: soulGet("chat_model", "beam-free"),
            variant: soulGet("chat_variant", ""),
            mimo_key: soulGet("mimo_key", "not set"),
            maton_key: soulGet("maton_key", "not set"),
            mail_auto_link: soulGet("mail_auto_link", "true") !== "false",
            mail_signature: soulGet("mail_signature", ""),
            user_name: soulGet("user_name", ""),
            role: soulGet("role", ""),
            voice: soulGet("style", ""),
            active_vertical: getActiveVertical(),
            verticals: listVerticals(),
            permission_gates: gates.permission ?? {},
            heartbeat_last_tick: soulGet("heartbeat_last_tick", ""),
            heartbeat_last_error: heartbeatError,
            cost_7d: costSummary(7),
            crm_port: Number(process.env.CRM_VIEW_PORT ?? 8800),
            elitza_home: (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (process.env.HOME + "/.ai-enablement-agent"),
          })
        }
        if (path === "/api/settings/vertical" && req.method === "POST") {
          const body = await readBody(req)
          const { setActiveVertical } = await import("./verticals.js")
          const ok = setActiveVertical(String(body.vertical ?? ""))
          return json({ ok })
        }
        if (path === "/api/settings/provider" && req.method === "POST") {
          const body = await readBody(req)
          const { soulSet } = await import("./soul.js")
          const provider = "opencode-go"
          soulSet("chat_provider", provider)
          soulSet("chat_model", "beam-free")
          return json({ ok: true, provider })
        }
        if (path === "/api/settings/model" && req.method === "POST") {
          const body = await readBody(req)
          const { soulSet } = await import("./soul.js")
          const model = String(body.model ?? "")
          if (model) soulSet("chat_model", model)
          return json({ ok: true, model })
        }
        if (path === "/api/settings/variant" && req.method === "POST") {
          const body = await readBody(req)
          const { soulSet } = await import("./soul.js")
          const variant = String(body.variant ?? "")
          soulSet("chat_variant", variant)
          return json({ ok: true, variant })
        }
        if (path === "/api/settings/variants" && req.method === "GET") {
          const model = url.searchParams.get("model") || ""
          // Fetch reasoning options from models.dev.
          let variants: string[] = []
          try {
            const res = await fetch("https://models.dev/api.json")
            const data = await res.json() as any
            // Find the model in opencode-go provider.
            const m = data?.["opencode-go"]?.models?.[model]
            if (m?.reasoning_options) {
              for (const opt of m.reasoning_options) {
                if (opt.type === "effort" && Array.isArray(opt.values)) {
                  variants = opt.values
                } else if (opt.type === "toggle") {
                  variants = ["default", "thinking"]
                }
              }
            }
          } catch { /* ignore */ }
          return json({ model, variants })
        }
        if (path === "/api/settings/models" && req.method === "GET") {
          const provider = "opencode-go"
          // Pull ALL models available for the OpenCode Go plan from the console.
          let models: string[] = []
          try {
            const Database = (await import("bun:sqlite")).default
            const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
            const db = new Database(dbPath, { readonly: true })
            const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
            db.close()
            if (row?.value) {
              const cred = JSON.parse(row.value)
              const access = cred.access
              const orgId = cred.metadata?.orgID
              const headers: Record<string, string> = { "Authorization": "Bearer " + access }
              if (orgId) headers["x-opencode-org-id"] = orgId
              const res = await fetch("https://opencode.ai/console/api/config", { headers })
              const data = await res.json() as any
              const m = Object.keys(data?.config?.provider?.["opencode-go"]?.models ?? {})
              console.error("[models] console returned", m.length, "models")
              if (m.length > 0) models = m
            } else {
              console.error("[models] no console credential found — connect OpenCode Go")
            }
          if (models.length === 0) models = ["beam-free"]
          } catch (e) { console.error("[models] error:", String(e)) }
          return json({ provider, models })
        }
        // --- OpenCode Go plan connection (console device flow) ---
        if (path === "/api/settings/opencode-status" && req.method === "GET") {
          try {
            const fs = await import("node:fs")
            const pathm = await import("node:path")
            const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
            if (!fs.existsSync(dbPath)) return json({ connected: false })
            const Database = (await import("bun:sqlite")).default
            const db = new Database(dbPath, { readonly: true })
            const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
            db.close()
            if (row?.value) {
              const cred = JSON.parse(row.value)
              return json({ connected: true, email: cred.metadata?.email ?? null, org: cred.metadata?.orgName ?? null, orgID: cred.metadata?.orgID ?? null, accountID: cred.metadata?.accountID ?? null })
            }
            return json({ connected: false })
          } catch (e) { return json({ connected: false }) }
        }
        if (path === "/api/settings/opencode-connect" && req.method === "POST") {
          try {
            const server = "https://opencode.ai/console"
            const res = await fetch(server + "/auth/device/code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ client_id: "opencode-cli", supports_org_scope: true }),
            })
            const data = await res.json() as any
            if (!data.device_code) return json({ error: data.error || "Failed to start device flow" }, 500)
            const verification = new URL(data.verification_uri_complete, server + "/")
            return json({ device_code: data.device_code, user_code: data.user_code, verification_url: verification.href, interval: data.interval || 5 })
          } catch (e) { return json({ error: String(e) }, 500) }
        }
        if (path === "/api/settings/opencode-poll" && req.method === "POST") {
          const body = await readBody(req)
          const deviceCode = String(body.device_code ?? "")
          if (!deviceCode) return json({ error: "device_code required" }, 400)
          const server = "https://opencode.ai/console"
          try {
            const res = await fetch(server + "/auth/device/token", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: "opencode-cli" }),
            })
            const data = await res.json() as any
            if (data.error === "authorization_pending") return json({ pending: true })
            if (data.error === "slow_down") return json({ pending: true, slow_down: true })
            if (data.error) return json({ error: data.error_description || data.error }, 400)
            if (!data.access_token) return json({ error: "No access token returned" }, 500)
            // Fetch user + orgs to build metadata.
            const userRes = await fetch(server + "/api/user", { headers: { "Authorization": "Bearer " + data.access_token } })
            const user = await userRes.json() as any
            const orgsRes = await fetch(server + "/api/orgs", { headers: { "Authorization": "Bearer " + data.access_token } })
            const orgs = await orgsRes.json() as any[]
            const org = (Array.isArray(orgs) && orgs.length) ? orgs[0] : null
            const credValue = JSON.stringify({
              type: "oauth",
              methodID: "device",
              access: data.access_token,
              refresh: data.refresh_token,
              expires: Date.now() + (data.expires_in || 3600) * 1000,
              metadata: { server, accountID: user.id, email: user.email, orgID: org?.id, orgName: org?.name },
            })
            // Store in the credential table (upsert: remove old opencode creds first).
            const fs = await import("node:fs")
            const pathm = await import("node:path")
            const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
            fs.mkdirSync(pathm.dirname(dbPath), { recursive: true })
            const Database = (await import("bun:sqlite")).default
            const db = new Database(dbPath)
            db.run(`CREATE TABLE IF NOT EXISTS credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)`)
            const now = Date.now()
            db.run("DELETE FROM credential WHERE integration_id = 'opencode'", [])
            const id = "cred_" + Math.random().toString(36).slice(2) + Date.now().toString(36)
            db.run("INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [id, "opencode", "OpenCode Console", credValue, null, "device", 1, now, now])
            db.close()
            return json({ ok: true, email: user.email, org: org?.name ?? null })
          } catch (e) { return json({ error: String(e) }, 500) }
        }
        // --- Skills management (Elitza skills = ~/.ai-enablement-agent/skills/<name>/SKILL.md) ---
        const skillsRoot = ((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || ((process.env.HOME || "") + "/.ai-enablement-agent")) + "/skills"
        const skillsManifestPath = ((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || ((process.env.HOME || "") + "/.ai-enablement-agent")) + "/skills-manifest.json"
        function loadSkillsManifest(): Record<string, { enabled: boolean }> {
          try {
            const fs = require("node:fs")
            if (!fs.existsSync(skillsManifestPath)) return {}
            return JSON.parse(fs.readFileSync(skillsManifestPath, "utf8")) || {}
          } catch { return {} }
        }
        function saveSkillsManifest(m: Record<string, { enabled: boolean }>) {
          const fs = require("node:fs")
          const pathm = require("node:path")
          fs.mkdirSync(pathm.dirname(skillsManifestPath), { recursive: true })
          fs.writeFileSync(skillsManifestPath, JSON.stringify(m, null, 2), { mode: 0o600 })
        }
        function parseSkillFrontmatter(content: string): { name: string; description: string } {
          const m = content.match(/^---\n([\s\S]*?)\n---/)
          const fm = m ? m[1] : ""
          const get = (k: string) => {
            const mm = fm.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))
            return mm ? mm[1].trim().replace(/^['"]|['"]$/g, "") : ""
          }
          return { name: get("name"), description: get("description") }
        }
        if (path === "/api/settings/skills" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathm = await import("node:path")
          fs.mkdirSync(skillsRoot, { recursive: true })
          const manifest = loadSkillsManifest()
          const entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
          const skills: any[] = []
          for (const e of entries) {
            if (!e.isDirectory()) continue
            const file = pathm.join(skillsRoot, e.name, "SKILL.md")
            if (!fs.existsSync(file)) continue
            const content = fs.readFileSync(file, "utf8")
            const fm = parseSkillFrontmatter(content)
            const enabled = manifest[e.name]?.enabled !== false
            skills.push({ name: fm.name || e.name, dir: e.name, description: fm.description, enabled, size: content.length })
          }
          return json({ skills })
        }
        const skillMatch = path.match(/^\/api\/settings\/skills\/([^/]+)$/)
        if (skillMatch && req.method === "GET") {
          const dir = decodeURIComponent(skillMatch[1])
          const fs = await import("node:fs")
          const pathm = await import("node:path")
          const file = pathm.join(skillsRoot, dir, "SKILL.md")
          if (!fs.existsSync(file)) return json({ error: "not found" }, 404)
          const content = fs.readFileSync(file, "utf8")
          const fm = parseSkillFrontmatter(content)
          const manifest = loadSkillsManifest()
          const enabled = manifest[dir]?.enabled !== false
          return json({ dir, name: fm.name || dir, description: fm.description, enabled, content })
        }
        if (path === "/api/settings/skills" && req.method === "POST") {
          const body = await readBody(req)
          const dir = String(body.dir || body.name || "").trim().replace(/[^a-zA-Z0-9._-]/g, "-")
          if (!dir) return json({ error: "name required" }, 400)
          const content = String(body.content ?? "")
          if (!content.trim()) return json({ error: "content required" }, 400)
          const fs = await import("node:fs")
          const pathm = await import("node:path")
          const skillDir = pathm.join(skillsRoot, dir)
          fs.mkdirSync(skillDir, { recursive: true })
          fs.writeFileSync(pathm.join(skillDir, "SKILL.md"), content, { mode: 0o644 })
          const manifest = loadSkillsManifest()
          manifest[dir] = { enabled: body.enabled !== false }
          saveSkillsManifest(manifest)
          return json({ ok: true, dir })
        }
        if (skillMatch && req.method === "PUT") {
          const dir = decodeURIComponent(skillMatch[1])
          const body = await readBody(req)
          const content = String(body.content ?? "")
          if (!content.trim()) return json({ error: "content required" }, 400)
          const fs = await import("node:fs")
          const pathm = await import("node:path")
          const file = pathm.join(skillsRoot, dir, "SKILL.md")
          if (!fs.existsSync(file)) return json({ error: "not found" }, 404)
          fs.writeFileSync(file, content, { mode: 0o644 })
          return json({ ok: true, dir })
        }
        if (skillMatch && path.endsWith("/toggle") && req.method === "POST") {
          // handled below via separate route check; placeholder
        }
        const skillToggleMatch = path.match(/^\/api\/settings\/skills\/([^/]+)\/toggle$/)
        if (skillToggleMatch && req.method === "POST") {
          const dir = decodeURIComponent(skillToggleMatch[1])
          const body = await readBody(req)
          const manifest = loadSkillsManifest()
          manifest[dir] = { enabled: body.enabled !== false }
          saveSkillsManifest(manifest)
          return json({ ok: true, dir, enabled: manifest[dir].enabled })
        }
        if (skillMatch && req.method === "DELETE") {
          const dir = decodeURIComponent(skillMatch[1])
          const fs = await import("node:fs")
          const pathm = await import("node:path")
          const skillDir = pathm.join(skillsRoot, dir)
          try { fs.rmSync(skillDir, { recursive: true, force: true }) } catch {}
          const manifest = loadSkillsManifest()
          delete manifest[dir]
          saveSkillsManifest(manifest)
          return json({ ok: true, dir })
        }

        // --- MCP server management (engine config: mcp.servers) ---
        function engineConfigPath(): string {
          const dir = process.env.OPENCODE_CONFIG_DIR ?? (process.env.XDG_CONFIG_HOME ?? ((process.env.HOME || "") + "/.config")) + "/opencode"
          return dir + "/opencode.json"
        }
        function loadEngineConfig(): any {
          const fs = require("node:fs")
          const p = engineConfigPath()
          if (!fs.existsSync(p)) return {}
          try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return {} }
        }
        function saveEngineConfig(cfg: any) {
          const fs = require("node:fs")
          const pathm = require("node:path")
          const p = engineConfigPath()
          fs.mkdirSync(pathm.dirname(p), { recursive: true })
          fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 })
        }
        if (path === "/api/settings/mcp" && req.method === "GET") {
          const cfg = loadEngineConfig()
          const servers = cfg.mcp?.servers ?? {}
          const list = Object.entries(servers).map(([name, c]) => ({ name, config: c }))
          return json({ servers: list })
        }
        const mcpMatch = path.match(/^\/api\/settings\/mcp\/([^/]+)$/)
        if (mcpMatch && req.method === "POST" && false) { /* placeholder */ }
        if (path === "/api/settings/mcp" && req.method === "POST") {
          const body = await readBody(req)
          const name = String(body.name || "").trim()
          if (!name) return json({ error: "name required" }, 400)
          const cfg = loadEngineConfig()
          if (!cfg.mcp) cfg.mcp = {}
          if (!cfg.mcp.servers) cfg.mcp.servers = {}
          cfg.mcp.servers[name] = body.config ?? {}
          saveEngineConfig(cfg)
          return json({ ok: true, name })
        }
        if (mcpMatch && req.method === "PUT") {
          const name = decodeURIComponent(mcpMatch[1])
          const body = await readBody(req)
          const cfg = loadEngineConfig()
          if (!cfg.mcp?.servers?.[name]) return json({ error: "not found" }, 404)
          cfg.mcp.servers[name] = body.config ?? cfg.mcp.servers[name]
          saveEngineConfig(cfg)
          return json({ ok: true, name })
        }
        if (mcpMatch && req.method === "DELETE") {
          const name = decodeURIComponent(mcpMatch[1])
          const cfg = loadEngineConfig()
          if (cfg.mcp?.servers?.[name]) {
            delete cfg.mcp.servers[name]
            saveEngineConfig(cfg)
          }
          return json({ ok: true, name })
        }

        // --- Chat history (Ask Elitza) ---
        function ensureChatTables() {
          const db = crmDb()
          db.run(`CREATE TABLE IF NOT EXISTS chat_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
          db.run(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`)
        }
        if (path === "/api/chat/sessions" && req.method === "GET") {
          ensureChatTables()
          const rows = crmDb().query("SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC").all() as any[]
          return json({ sessions: rows })
        }
        if (path === "/api/chat/sessions" && req.method === "POST") {
          ensureChatTables()
          const body = await readBody(req)
          const title = String(body.title ?? "New chat").slice(0, 80)
          const now = new Date().toISOString()
          const r = crmDb().run("INSERT INTO chat_sessions (title, created_at, updated_at) VALUES (?, ?, ?)", [title, now, now])
          const id = Number(r.lastInsertRowid)
          return json({ id, title, created_at: now, updated_at: now })
        }
        const chatSessionMatch = path.match(/^\/api\/chat\/sessions\/(\d+)$/)
        if (chatSessionMatch && req.method === "GET") {
          ensureChatTables()
          const id = Number(chatSessionMatch[1])
          const s = crmDb().query("SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ?").get(id) as any
          if (!s) return json({ error: "not found" }, 404)
          const messages = crmDb().query("SELECT id, role, text, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC").all(id) as any[]
          return json({ session: s, messages })
        }
        if (chatSessionMatch && req.method === "PUT") {
          ensureChatTables()
          const id = Number(chatSessionMatch[1])
          const body = await readBody(req)
          const title = String(body.title ?? "").slice(0, 80)
          if (title) crmDb().run("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?", [title, new Date().toISOString(), id])
          return json({ ok: true, id })
        }
        if (chatSessionMatch && req.method === "DELETE") {
          ensureChatTables()
          const id = Number(chatSessionMatch[1])
          crmDb().run("DELETE FROM chat_messages WHERE session_id = ?", [id])
          crmDb().run("DELETE FROM chat_sessions WHERE id = ?", [id])
          return json({ ok: true, id })
        }
        const chatMsgMatch = path.match(/^\/api\/chat\/sessions\/(\d+)\/messages$/)
        if (chatMsgMatch && req.method === "POST") {
          ensureChatTables()
          const id = Number(chatMsgMatch[1])
          const body = await readBody(req)
          const role = String(body.role ?? "user")
          const text = String(body.text ?? "")
          if (!text.trim()) return json({ error: "text required" }, 400)
          const now = new Date().toISOString()
          const r = crmDb().run("INSERT INTO chat_messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)", [id, role, text, now])
          crmDb().run("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", [now, id])
          return json({ id: Number(r.lastInsertRowid), role, text, created_at: now })
        }

        if (path === "/api/settings/backup" && req.method === "POST") {
          const { execSync } = await import("node:child_process")
          const fs = await import("node:fs")
          const os = await import("node:os")
          const pathm = await import("node:path")
          const home = process.env.HOME || os.homedir()
          const stamp = new Date().toISOString().slice(0, 10)
          const out = pathm.join(home, "elitza-backup-" + stamp + ".tar.gz")
          // Also snapshot the CRM database (checkpoint WAL first) so gathered leads are preserved.
          try {
            const { crmDb } = await import("./crm.js")
            try { crmDb().exec("PRAGMA wal_checkpoint(TRUNCATE)") } catch {}
          } catch {}
          const backupDir = pathm.join(home, ".ai-enablement-agent", "backups")
          try { fs.mkdirSync(backupDir, { recursive: true }) } catch {}
          const crmDbPath = pathm.join(home, ".ai-enablement-agent", "brain", "crm.db")
          const crmBackup = pathm.join(backupDir, "crm-" + stamp + ".db")
          try { fs.copyFileSync(crmDbPath, crmBackup) } catch {}
          try {
            execSync("tar -czf " + out + " -C " + home + " .elitza", { stdio: "pipe" })
            return json({ ok: true, path: out, crm_backup: crmBackup })
          } catch (e) { return json({ ok: false, error: String(e) }, 500) }
        }
        if (path === "/api/settings/maton" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const p = pathMod.join(os.homedir(), ".config", "maton", "credentials.env")
          let set = false
          try {
            const txt = fs.readFileSync(p, "utf8")
            for (const line of txt.split("\n")) {
              const t = line.trim()
              if (t.startsWith("MATON_API_KEY=") && t.slice("MATON_API_KEY=".length).trim()) { set = true; break }
            }
          } catch {}
          return json({ set })
        }
        if (path === "/api/settings/maton" && req.method === "POST") {
          const body = await readBody(req)
          const key = String(body.key ?? "").trim()
          if (!key) return json({ error: "key required" }, 400)
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const dir = pathMod.join(os.homedir(), ".config", "maton")
          fs.mkdirSync(dir, { recursive: true })
          const p = pathMod.join(dir, "credentials.env")
          fs.writeFileSync(p, "MATON_API_KEY=" + key + "\\n", { mode: 0o600 })
          try { fs.chmodSync(p, 0o600) } catch {}
          const { soulSet } = await import("./soul.js")
          soulSet("maton_key", "set")
          return json({ ok: true, set: true })
        }
        if (path === "/api/settings/secret" && req.method === "POST") {
          const body = await readBody(req)
          const name = String(body.name ?? "").trim()
          const value = String(body.value ?? "").trim()
          if (!name || !value) return json({ error: "name and value required" }, 400)
          const allowed = new Set(["XIAOMI_API_KEY", "GOOGLE_MAPS_API_KEY", "RESEND_API_KEY", "RESEND_FROM", "RESEND_FROM_SALES", "RESEND_FROM_SUPPORT", "RESEND_FROM_HELLO", "RESEND_FROM_OUTREACH", "TOWER_WEBHOOK_URL", "TOWER_WEBHOOK_TOKEN", "TOWER_CALLBACK_SECRET", "TOWER_CALLBACK_URL"])
          if (!allowed.has(name)) return json({ error: "unknown secret" }, 400)
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          const envPath = pathMod.join(home, ".env")
          // read existing
          let lines: string[] = []
          try { lines = fs.readFileSync(envPath, "utf8").split("\n") } catch {}
          const filtered = lines.filter((l) => !l.trim().startsWith(name + "="))
          filtered.push(name + "=" + value)
          fs.mkdirSync(pathMod.dirname(envPath), { recursive: true })
          fs.writeFileSync(envPath, filtered.filter(Boolean).join("\n") + "\n", { mode: 0o600 })
          try { fs.chmodSync(envPath, 0o600) } catch {}
          process.env[name] = value
          const { soulSet } = await import("./soul.js")
          soulSet(name.toLowerCase().replace(/_/g, "_"), "set")
          return json({ ok: true, set: true })
        }
        if (path === "/api/settings/secrets-status" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          const envPath = pathMod.join(home, ".env")
          let env: Record<string, string> = {}
          try {
            for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
              const t = line.trim()
              if (!t || t.startsWith("#")) continue
              const eq = t.indexOf("=")
              if (eq < 0) continue
              env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
            }
          } catch {}
          // maton
          let matonSet = false
          try {
            const p = pathMod.join(os.homedir(), ".config", "maton", "credentials.env")
            for (const line of fs.readFileSync(p, "utf8").split("\n")) {
              const t = line.trim()
              if (t.startsWith("MATON_API_KEY=") && t.slice("MATON_API_KEY=".length).trim()) { matonSet = true }
            }
          } catch {}
          return json({
            xiaomi: !!env["XIAOMI_API_KEY"],
            google_maps: !!env["GOOGLE_MAPS_API_KEY"],
            resend: !!env["RESEND_API_KEY"],
            resend_from: !!env["RESEND_FROM"],
            resend_from_sales: !!env["RESEND_FROM_SALES"],
            resend_from_support: !!env["RESEND_FROM_SUPPORT"],
            resend_from_hello: !!env["RESEND_FROM_HELLO"],
            resend_from_outreach: !!env["RESEND_FROM_OUTREACH"],
            tower_webhook_url: !!env["TOWER_WEBHOOK_URL"],
            tower_webhook_token: !!env["TOWER_WEBHOOK_TOKEN"],
            tower_callback_secret: !!env["TOWER_CALLBACK_SECRET"],
            tower_callback_url: !!env["TOWER_CALLBACK_URL"],
            maton: matonSet,
          })
        }
        const towerConsoleMatch = path.match(/^\/api\/clients\/(\d+)\/tower-console$/)
        if (towerConsoleMatch && req.method === "GET") {
          const id = Number(towerConsoleMatch[1])
          const { getTowerConsole } = await import("./tower.js")
          const st = getTowerConsole(id)
          return json({ active: st.active, status: st.status, execution_id: st.execution_id, lines: st.lines })
        }
        if (path === "/api/tower/dispatch" && req.method === "POST") {
          const body = await readBody(req)
          const clientId = Number(body.client_id ?? body.clientId)
          const event = String(body.event ?? "").trim()
          const eventPayload = (body.event_payload && typeof body.event_payload === "object") ? body.event_payload as Record<string, unknown> : undefined
          if (!Number.isFinite(clientId)) return json({ error: "client_id required" }, 400)
          const validEvents = ["outbound_prep","inbound_received","call_prep","call_completed","milestone_update","payment_check","job_done_paid"]
          if (!validEvents.includes(event)) return json({ error: "invalid event" }, 400)
          // save call sheet answers when call_completed
          if (event === "call_completed" && eventPayload && (eventPayload as any).call_sheet_answers) {
            try {
              const { setCustomField } = await import("./crm.js")
              setCustomField(clientId, "last_call_sheet_json", JSON.stringify((eventPayload as any).call_sheet_answers))
            } catch {}
          }
          const { dispatchToTower } = await import("./tower.js")
          // Fire-and-forget: do not block the HTTP response on local scraping / webhook.
          dispatchToTower(clientId, event as any, eventPayload).catch(async (e) => {
            try {
              const mod = await import("./tower.js")
              mod.appendTowerConsole(clientId, "error", `Dispatch error: ${String(e)}`)
            } catch {}
          })
          return json({ ok: true, started: true }, 202)
        }
        if (path === "/api/tower/callback") {
          if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405)
          const body = await readBody(req)
          const auth = req.headers.get("authorization")
          const { handleTowerCallback, appendTowerConsole } = await import("./tower.js")
          const clientId = Number(body?.client_id)
          const action = String(body?.action ?? "").trim()
          const r = await handleTowerCallback(body, auth)
          if (Number.isFinite(clientId) && clientId > 0) {
            try {
              if (r.ok) appendTowerConsole(clientId, "ok", `CRM Callback: ${action} -> HTTP 200`)
              else appendTowerConsole(clientId, "error", `CRM Callback: ${action} -> HTTP ${r.status}: ${r.error || ""}`)
            } catch {}
          }
          return json(r.ok ? { ok: true, result: r.result } : { error: r.error }, r.status)
        }
        const callKitMatch = path.match(/^\/api\/tower\/call-kit\/(\d+)$/)
        if (callKitMatch && req.method === "GET") {
          const clientId = Number(callKitMatch[1])
          const { getCustomFields } = await import("./crm.js")
          const fields = getCustomFields(clientId)
          let callKit: unknown = null
          if (fields.tower_call_kit) {
            try { callKit = JSON.parse(fields.tower_call_kit) } catch { callKit = fields.tower_call_kit }
          }
          // fallback: latest call_kit asset
          if (!callKit) {
            try {
              const { listAssets } = await import("./crm.js")
              const assets = listAssets(clientId).filter((a) => a.kind === "call_kit")
              const last = assets[assets.length - 1]
              if (last?.path) {
                const fs = await import("node:fs")
                const raw = fs.readFileSync(last.path, "utf8")
                try { callKit = JSON.parse(raw) } catch { callKit = raw }
              }
            } catch {}
          }
          return json({ client_id: clientId, call_kit: callKit, last_call_sheet: fields.last_call_sheet_json ? (() => { try { return JSON.parse(fields.last_call_sheet_json) } catch { return fields.last_call_sheet_json } })() : null })
        }
        if (path === "/api/settings/mail" && req.method === "GET") {
          const { soulGet } = await import("./soul.js")
          return json({ auto_link: soulGet("mail_auto_link", "true") !== "false", signature: soulGet("mail_signature", "") })
        }
        if (path === "/api/settings/mail" && req.method === "POST") {
          const body = await readBody(req)
          const { soulSet } = await import("./soul.js")
          if (body.auto_link !== undefined) soulSet("mail_auto_link", body.auto_link ? "true" : "false")
          if (body.signature !== undefined) soulSet("mail_signature", String(body.signature ?? ""))
          const { soulGet } = await import("./soul.js")
          return json({ ok: true, auto_link: soulGet("mail_auto_link", "true") !== "false", signature: soulGet("mail_signature", "") })
        }
        if (path === "/api/leads/ready" && req.method === "GET") {
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 10)))
          const idParam = url.searchParams.get("id")
          const includeNonEmail = url.searchParams.get("include_non_email") === "1"
          const cityParam = (url.searchParams.get("city") ?? "").trim().toLowerCase()
          const params = []
          const filters = ["notes IS NOT NULL", "TRIM(notes) <> ''"]

          if (idParam) {
            filters.push("id = ?")
            params.push(Number(idParam))
          } else {
            if (!includeNonEmail) {
              filters.push("email IS NOT NULL", "TRIM(email) <> ''")
              filters.push("COALESCE(outreach_route, 'email_ready') = 'email_ready'")
            }
            filters.push("status NOT IN ('no', 'stale', 'not_enough_info', 'done')")
            filters.push("id NOT IN (SELECT client_id FROM pipeline WHERE touch > 0 OR queued_touch > 0)")
          }
          if (cityParam) {
            filters.push("LOWER(address) LIKE ?")
            params.push("%" + cityParam + "%")
          }
          const where = "WHERE " + filters.join(" AND ")
          const rawRows = crmDb().query(`SELECT * FROM clients ${where} ORDER BY id LIMIT ?`).all(...params, limit * 2) as any[]
          const filtered = idParam || includeNonEmail
            ? rawRows
            : rawRows.filter((c) => isSendableOutreachEmail(c.email, { website: c.website, businessName: c.company || c.name }))
          const leads = filtered.slice(0, limit).map(serializeReadyLead)
          return new Response(JSON.stringify(leads, null, 2), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (path === "/api/clients" && req.method === "GET") {
          const status = url.searchParams.get("status") ?? undefined
          const query = url.searchParams.get("q") ?? undefined
          const sort = url.searchParams.get("sort") ?? undefined
          const dir = (url.searchParams.get("dir") === "asc" ? "asc" : "desc") as "asc" | "desc"
          const pipeline = url.searchParams.get("pipeline") === "1"
          const all = url.searchParams.get("all") === "1"
          if (all) {
            const clients = findClients({ status, query, sort, dir, pipeline, all: true })
            const total = countClients({ status, query, pipeline })
            return json({ clients, total, page: 1, per_page: total, sort, dir, all: true })
          }
          const perPage = Math.max(1, Math.min(200, Number(url.searchParams.get("per_page") ?? url.searchParams.get("limit") ?? 50)))
          const page = Math.max(1, Number(url.searchParams.get("page") ?? 1))
          const offset = (page - 1) * perPage
          const clients = findClients({ status, query, sort, dir, pipeline, limit: perPage, offset })
          const total = countClients({ status, query, pipeline })
          return json({ clients, total, page, per_page: perPage, sort, dir })
        }
        // Pipeline stages config
        if (path === "/api/pipeline/stages" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          const filePath = pathMod.join(home, "pipeline-stages.json")
          let stages: any[]
          try {
            stages = JSON.parse(fs.readFileSync(filePath, "utf8"))
            if (!Array.isArray(stages) || stages.length === 0) stages = DEFAULT_STAGES
          } catch {
            stages = DEFAULT_STAGES
          }
          // Ensure any status actually in use by a client gets a column, so a
          // lead's status is never invisible in the pipeline. Configured stages
          // that have no clients can still be deleted and will disappear.
          const seen = new Set(stages.map((s: any) => s.id))
          // Guarantee the initial "scouted" stage always exists (permanent).
          if (!seen.has("scouted")) {
            stages.unshift({ id: "scouted", label: "Scouted", color: "#62666d", statusColor: "muted" })
            seen.add("scouted")
          }
          try {
            const used = crmDb().query("SELECT DISTINCT status FROM clients").all() as any[]
            for (const r of used) {
              if (r.status && !seen.has(r.status)) {
                stages.push({ id: r.status, label: r.status, color: "#62666d", statusColor: "muted" })
                seen.add(r.status)
              }
            }
          } catch { /* best effort */ }
          // Migrate orphaned clients: move any client whose status is not in the configured stages to the first stage.
          // No auto-migration: statuses are preserved as-is. In-use statuses
          // always get a column (see merge above), so nothing is lost.
          return json({ stages })
        }
        if (path === "/api/pipeline/stages" && req.method === "POST") {
          const body = await readBody(req)
          let stages = Array.isArray(body.stages) ? body.stages : []
          if (stages.length === 0) stages = DEFAULT_STAGES
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          const filePath = pathMod.join(home, "pipeline-stages.json")
          fs.writeFileSync(filePath, JSON.stringify(stages, null, 2), { mode: 0o600 })
          // Migrate orphaned clients to the first stage.
          // No auto-migration: statuses are preserved as-is.
          return json({ ok: true, stages })
        }
        if (path === "/api/companies" && req.method === "GET") {
          const q = (url.searchParams.get("q") ?? "").toLowerCase()
          let companies = listCompanies()
          if (q) companies = companies.filter((c) => c.name.toLowerCase().includes(q))
          return json({ companies, total: companies.length })
        }
        if (path === "/api/company" && req.method === "GET") {
          const name = url.searchParams.get("name") ?? ""
          if (!name) return json({ error: "name required" }, 400)
          const clients = crmDb().query("SELECT * FROM clients WHERE company = ? ORDER BY updated_at DESC").all(name) as any[]
          // derive domain from contacts' emails
          const free = new Set(["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","live.com","aol.com","mail.com","protonmail.com","gmx.com","yandex.com","me.com","msn.com","googlemail.com"])
          const domainCounts = new Map<string, number>()
          for (const c of clients) {
            const e = String(c.email || "")
            const at = e.indexOf("@")
            if (at < 0) continue
            const d = e.slice(at + 1).toLowerCase().trim()
            if (!d || free.has(d)) continue
            domainCounts.set(d, (domainCounts.get(d) || 0) + 1)
          }
          let topDomain = ""
          let topCount = 0
          for (const [d, n] of domainCounts) { if (n > topCount) { topCount = n; topDomain = d } }
          return json({ name, clients, count: clients.length, domain: topDomain })
        }
        const clientMatch = path.match(/^\/api\/clients\/(\d+)$/)
        if (clientMatch && req.method === "GET") {
          const id = Number(clientMatch[1])
          const client = getClient(id)
          if (!client) return json({ error: "not found" }, 404)
          return json({ client, interactions: listInteractions(id), assets: listAssets(id) })
        }
        const autopilotMatch = path.match(/^\/api\/clients\/(\d+)\/autopilot$/)
        if (autopilotMatch && req.method === "POST") {
          const id = Number(autopilotMatch[1])
          // start background job (fire-and-forget), like enrich
          const job: { lines: string[]; running: boolean; done: boolean; error?: string; result?: any } = { lines: [], running: true, done: false }
          autopilotJobs.set(id, job)
          const jobId = "autopilot_" + id + "_" + Date.now()
          const djob = { type: "autopilot", id: jobId, lines: job.lines, running: true, done: false, error: undefined as string | undefined, result: undefined as any }
          debugJobs.set(jobId, djob)
          const log = (l: string) => { job.lines.push(l); djob.lines = job.lines; dbg(l) }
          ;(async () => {
            try {
              log("Autopilot started for client " + id)
              const { runCaseAutopilot } = await import("./autopilot.js")
              const hud = await runCaseAutopilot(id, { onProgress: (l: string) => { job.lines.push(l); djob.lines = job.lines; dbg(l) } })
              job.result = hud
              job.done = true
              job.running = false
              djob.done = true
              djob.running = false
              djob.result = hud
              log("Track: " + (hud.track || ""))
              if (hud.draft_path) log("Draft: " + hud.draft_path)
              if (hud.do_now && hud.do_now.length) log("Do now: " + hud.do_now.join(" | "))
            } catch (e) {
              job.error = String(e)
              job.done = true
              job.running = false
              djob.error = String(e)
              djob.done = true
              djob.running = false
              log("ERROR: " + String(e))
            }
          })()
          return json({ started: true, client_id: id })
        }
        const autopilotStatusMatch = path.match(/^\/api\/autopilot\/status\/(\d+)$/)
        if (autopilotStatusMatch && req.method === "GET") {
          const id = Number(autopilotStatusMatch[1])
          const job = autopilotJobs.get(id)
          if (!job) return json({ running: false, done: false, lines: [] })
          return json({ running: job.running, done: job.done, error: job.error ?? null, result: job.result ?? null, lineCount: job.lines.length })
        }
        const autopilotLogMatch = path.match(/^\/api\/autopilot\/log\/(\d+)$/)
        if (autopilotLogMatch && req.method === "GET") {
          const id = Number(autopilotLogMatch[1])
          const after = Number(url.searchParams.get("after") ?? 0)
          const job = autopilotJobs.get(id)
          const lines = job ? job.lines.slice(after) : []
          return json({ lines, total: job ? job.lines.length : 0, running: job?.running ?? false, done: job?.done ?? false, error: job?.error ?? null })
        }
        const hudMatch = path.match(/^\/api\/clients\/(\d+)\/hud$/)
        if (hudMatch && req.method === "GET") {
          const id = Number(hudMatch[1])
          const client = getClient(id)
          if (!client) return json({ error: "not found" }, 404)
          const { resolvePlaybook, renderPlaceholders } = await import("./playbooks.js")
          const { routeClientTrack } = await import("./routing.js")
          const pb = resolvePlaybook(id)
          const { pricing } = routeClientTrack(client)
          const stage = client.status || "scouted"
          const stagePb = pb?.stages?.[stage] ?? pb?.stages?.["scouted"]
          return json({ client, track: client.offer_track, pricing, stage, do_now: stagePb?.what_to_do ?? [], say_this: stagePb?.what_to_say ?? [], never_say: stagePb?.what_not_to_say ?? [], objections: stagePb?.objection_handlers ?? [], staged_assets: [], deal: null, draft_path: null })
        }
        if (path === "/api/clients" && req.method === "POST") {
          const body = await readBody(req)
          const { client, created } = addClient({
            name: String(body.name ?? ""),
            vertical: body.vertical, status: body.status, score: body.score,
            address: body.address, phone: body.phone, website: body.website, email: body.email,
            linkedin: body.linkedin, twitter: body.twitter, facebook: body.facebook, instagram: body.instagram,
            notes: body.notes, deal_value: body.deal_value, source: body.source,
            next_action: body.next_action, next_action_at: body.next_action_at,
            language: body.language,
          })
          return json({ client, created })
        }
        // CSV import
        if (path === "/api/clients/import" && req.method === "POST") {
          const body = await readBody(req)
          const csv = String(body.csv ?? "")
          const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
          if (lines.length === 0) return json({ created: 0, errors: [] })
          const parseRow = (line: string): string[] => {
            const out = []
            let cur = ""
            let inQ = false
            for (let i = 0; i < line.length; i++) {
              const ch = line[i]
              if (ch === '"') { inQ = !inQ; continue }
              if (ch === ',' && !inQ) { out.push(cur); cur = ""; continue }
              cur += ch
            }
            out.push(cur)
            return out.map((v) => v.trim())
          }
          const header = parseRow(lines[0]).map((h) => h.toLowerCase())
          const hasHeader = header.includes("name")
          const dataLines = hasHeader ? lines.slice(1) : lines
          const colIndex = (name: string) => (hasHeader ? header.indexOf(name) : -1)
          let created = 0
          const errors = []
          for (const line of dataLines) {
            try {
              const vals = parseRow(line)
              const get = (key: string): string => {
                const i = colIndex(key)
                if (i >= 0 && i < vals.length) return vals[i]
                const pos = { name:0, email:1, phone:2, website:3, address:4, vertical:5, language:6, notes:7 }
                const idx = pos[key as keyof typeof pos]
                if (idx !== undefined && idx < vals.length) return vals[idx]
                return ""
              }
              const name = get("name")
              if (!name) { errors.push("missing name: " + line); continue }
              addClient({
                name,
                email: get("email") || undefined,
                phone: get("phone") || undefined,
                website: get("website") || undefined,
                address: get("address") || undefined,
                vertical: get("vertical") || undefined,
                language: get("language") || "it",
                notes: get("notes") || undefined,
                source: "csv_import",
                status: "scouted",
              })
              created++
            } catch (e) { errors.push(String(e)) }
          }
          return json({ created, errors })
        }
        // Products (My Products — the expert's own stack)
        if (path === "/api/products" && req.method === "GET") {
          const type = url.searchParams.get("type") ?? undefined
          const { listProducts } = await import("./crm.js")
          return json({ products: listProducts(type) })
        }
        if (path === "/api/products" && req.method === "POST") {
          const body = await readBody(req)
          const { addProduct } = await import("./crm.js")
          try {
            const product = addProduct({
              name: String(body.name ?? ""),
              type: body.type, description: body.description, price: body.price != null ? Number(body.price) : null,
              currency: body.currency, url: body.url, audience: body.audience, deliverable: body.deliverable, notes: body.notes,
            })
            return json({ product })
          } catch (e) { return json({ error: String(e) }, 400) }
        }
        const prodMatch = path.match(/^\/api\/products\/(\d+)$/)
        if (prodMatch && req.method === "GET") {
          const { getProduct } = await import("./crm.js")
          const product = getProduct(Number(prodMatch[1]))
          if (!product) return json({ error: "not found" }, 404)
          return json({ product })
        }
        if (prodMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateProduct } = await import("./crm.js")
          const product = updateProduct(Number(prodMatch[1]), {
            name: body.name, type: body.type, description: body.description,
            price: body.price != null ? Number(body.price) : body.price, currency: body.currency,
            url: body.url, audience: body.audience, deliverable: body.deliverable, notes: body.notes,
          })
          if (!product) return json({ error: "not found" }, 404)
          return json({ product })
        }
        if (prodMatch && req.method === "DELETE") {
          const { deleteProduct } = await import("./crm.js")
          const ok = deleteProduct(Number(prodMatch[1]))
          return json({ ok })
        }

        // Marketing: Email Campaigns
        if (path === "/api/mkt/email-campaigns" && req.method === "GET") {
          const { listMktEmailCampaigns } = await import("./crm.js")
          const status = url.searchParams.get("status") ?? undefined
          return json({ campaigns: listMktEmailCampaigns(status) })
        }
        if (path === "/api/mkt/email-campaigns" && req.method === "POST") {
          const body = await readBody(req)
          const { addMktEmailCampaign } = await import("./crm.js")
          try { return json({ campaign: addMktEmailCampaign(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const mktEmailMatch = path.match(/^\/api\/mkt\/email-campaigns\/(\d+)$/)
        if (mktEmailMatch && req.method === "GET") {
          const { getMktEmailCampaign } = await import("./crm.js")
          const c = getMktEmailCampaign(Number(mktEmailMatch[1]))
          if (!c) return json({ error: "not found" }, 404)
          return json({ campaign: c })
        }
        if (mktEmailMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateMktEmailCampaign } = await import("./crm.js")
          const c = updateMktEmailCampaign(Number(mktEmailMatch[1]), body)
          if (!c) return json({ error: "not found" }, 404)
          return json({ campaign: c })
        }
        if (mktEmailMatch && req.method === "DELETE") {
          const { deleteMktEmailCampaign } = await import("./crm.js")
          return json({ ok: deleteMktEmailCampaign(Number(mktEmailMatch[1])) })
        }

        // Marketing: Ads
        if (path === "/api/mkt/ads" && req.method === "GET") {
          const { listMktAds } = await import("./crm.js")
          const status = url.searchParams.get("status") ?? undefined
          const platform = url.searchParams.get("platform") ?? undefined
          return json({ ads: listMktAds(status, platform) })
        }
        if (path === "/api/mkt/ads" && req.method === "POST") {
          const body = await readBody(req)
          const { addMktAd } = await import("./crm.js")
          try { return json({ ad: addMktAd(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const mktAdMatch = path.match(/^\/api\/mkt\/ads\/(\d+)$/)
        if (mktAdMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateMktAd } = await import("./crm.js")
          const a = updateMktAd(Number(mktAdMatch[1]), body)
          if (!a) return json({ error: "not found" }, 404)
          return json({ ad: a })
        }
        if (mktAdMatch && req.method === "DELETE") {
          const { deleteMktAd } = await import("./crm.js")
          return json({ ok: deleteMktAd(Number(mktAdMatch[1])) })
        }

        // Marketing: Content Calendar
        if (path === "/api/mkt/content" && req.method === "GET") {
          const { listMktContent } = await import("./crm.js")
          const status = url.searchParams.get("status") ?? undefined
          const platform = url.searchParams.get("platform") ?? undefined
          return json({ items: listMktContent(status, platform) })
        }
        if (path === "/api/mkt/content" && req.method === "POST") {
          const body = await readBody(req)
          const { addMktContent } = await import("./crm.js")
          try { return json({ item: addMktContent(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const mktContentMatch = path.match(/^\/api\/mkt\/content\/(\d+)$/)
        if (mktContentMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateMktContent } = await import("./crm.js")
          const c = updateMktContent(Number(mktContentMatch[1]), body)
          if (!c) return json({ error: "not found" }, 404)
          return json({ item: c })
        }
        if (mktContentMatch && req.method === "DELETE") {
          const { deleteMktContent } = await import("./crm.js")
          return json({ ok: deleteMktContent(Number(mktContentMatch[1])) })
        }

        // Marketing: Reachout Campaigns
        if (path === "/api/mkt/reachout/campaigns" && req.method === "GET") {
          const { listMktReachoutCampaigns } = await import("./crm.js")
          const status = url.searchParams.get("status") ?? undefined
          return json({ campaigns: listMktReachoutCampaigns(status) })
        }
        if (path === "/api/mkt/reachout/campaigns" && req.method === "POST") {
          const body = await readBody(req)
          const { addMktReachoutCampaign } = await import("./crm.js")
          try { return json({ campaign: addMktReachoutCampaign(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const reachoutCampMatch = path.match(/^\/api\/mkt\/reachout\/campaigns\/(\d+)$/)
        if (reachoutCampMatch && req.method === "GET") {
          const { getMktReachoutCampaign, getReachoutStats } = await import("./crm.js")
          const c = getMktReachoutCampaign(Number(reachoutCampMatch[1]))
          if (!c) return json({ error: "not found" }, 404)
          return json({ campaign: c, stats: getReachoutStats(Number(reachoutCampMatch[1])) })
        }
        if (reachoutCampMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateMktReachoutCampaign } = await import("./crm.js")
          const c = updateMktReachoutCampaign(Number(reachoutCampMatch[1]), body)
          if (!c) return json({ error: "not found" }, 404)
          return json({ campaign: c })
        }
        if (reachoutCampMatch && req.method === "DELETE") {
          const { deleteMktReachoutCampaign } = await import("./crm.js")
          return json({ ok: deleteMktReachoutCampaign(Number(reachoutCampMatch[1])) })
        }
        const reachoutQueueMatch = path.match(/^\/api\/mkt\/reachout\/campaigns\/(\d+)\/queue$/)
        if (reachoutQueueMatch && req.method === "GET") {
          const { listMktReachoutQueue } = await import("./crm.js")
          return json({ queue: listMktReachoutQueue(Number(reachoutQueueMatch[1])) })
        }
        const reachoutBuildMatch = path.match(/^\/api\/mkt\/reachout\/campaigns\/(\d+)\/build$/)
        if (reachoutBuildMatch && req.method === "POST") {
          const body = await readBody(req)
          const { buildReachoutSchedule } = await import("./crm.js")
          try {
            const ids = (body.recipient_ids || []).map(Number)
            const r = buildReachoutSchedule(Number(reachoutBuildMatch[1]), ids)
            return json(r)
          } catch (e) { return json({ error: String(e) }, 400) }
        }
        const reachoutRecsMatch = path.match(/^\/api\/mkt\/reachout\/campaigns\/(\d+)\/recipients$/)
        if (reachoutRecsMatch && req.method === "GET") {
          // Return clients matching segment/status filter for recipient selection
          const { findClients } = await import("./crm.js")
          const status = url.searchParams.get("status") ?? undefined
          const clients = findClients({ status, limit: 500 })
          return json({ clients: clients.filter((c: any) => c.email) })
        }
        const reachoutSendMatch = path.match(/^\/api\/mkt\/reachout\/campaigns\/(\d+)\/send-due$/)
        if (reachoutSendMatch && req.method === "POST") {
          const campaignId = Number(reachoutSendMatch[1])
          const { getMktReachoutCampaign, listMktReachoutQueue, updateMktReachoutQueue } = await import("./crm.js") as any
          // updateMktReachoutQueue may not exist; handle inline
          const campaign = getMktReachoutCampaign(campaignId)
          if (!campaign) return json({ error: "not found" }, 404)
          const apiKey = process.env.RESEND_API_KEY?.trim()
          const from = campaign.from_email || process.env.RESEND_FROM?.trim()
          if (!apiKey) return json({ error: "RESEND_API_KEY not set" }, 400)
          if (!from) return json({ error: "RESEND_FROM not set" }, 400)
          const body = await readBody(req)
          const batchSize = Math.max(1, Math.min(25, Number(body.batch_size ?? campaign.batch_size ?? 10)))
          const db = (await import("./crm.js")).crmDb()
          const due = db.query("SELECT q.*, c.name AS cname, c.email AS cemail FROM mkt_reachout_queue q LEFT JOIN clients c ON c.id = q.client_id WHERE q.campaign_id = ? AND q.status = 'queued' AND q.scheduled_at <= ? ORDER BY q.scheduled_at ASC LIMIT ?").all(campaignId, new Date().toISOString(), batchSize) as any[]
          const result = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] }
          for (const row of due) {
            if (!row.cemail) { db.run("UPDATE mkt_reachout_queue SET status='skipped', error='no email' WHERE id=?", [row.id]); result.skipped++; continue }
            // render template
            const subject = (campaign.subject || '').replace(/\{name\}/g, row.cname || '').replace(/\{email\}/g, row.cemail || '')
            const text = (campaign.body || '').replace(/\{name\}/g, row.cname || '').replace(/\{email\}/g, row.cemail || '')
            try {
              const r = await fetch((process.env.RESEND_URL || 'https://api.resend.com') + '/emails', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from, to: [row.cemail], subject, text }),
              })
              if (!r.ok) {
                const detail = (await r.text()).slice(0, 200)
                db.run("UPDATE mkt_reachout_queue SET status='failed', error=? WHERE id=?", [`HTTP ${r.status}: ${detail}`, row.id])
                result.failed++; result.errors.push(`${row.cname}: HTTP ${r.status}`)
                continue
              }
              const sentAt = new Date().toISOString()
              db.run("UPDATE mkt_reachout_queue SET status='sent', sent_at=? WHERE id=?", [sentAt, row.id])
              result.sent++
              // buffer delay
              const minB = campaign.buffer_min_sec || 120
              const maxB = campaign.buffer_max_sec || 300
              const delay = (minB + Math.random() * (maxB - minB)) * 1000
              await new Promise((res) => setTimeout(res, Math.min(delay, 5000)))
            } catch (e) {
              db.run("UPDATE mkt_reachout_queue SET status='failed', error=? WHERE id=?", [String(e).slice(0,200), row.id])
              result.failed++; result.errors.push(`${row.cname}: ${String(e)}`)
            }
          }
          return json(result)
        }
        const reachoutRecommendedMatch = path.match(/^\/api\/mkt\/reachout\/recommended-cap$/)
        if (reachoutRecommendedMatch && req.method === "GET") {
          const stage = Number(url.searchParams.get("stage") ?? 2)
          const { reachoutRecommendedCap } = await import("./crm.js")
          return json(reachoutRecommendedCap(stage))
        }
        // Marketing: Referrals (client-to-client and attorney-to-attorney split-fee)
        if (path === "/api/mkt/referrals" && req.method === "GET") {
          const { listReferrals } = await import("./crm.js")
          const type = url.searchParams.get("type") ?? undefined
          const status = url.searchParams.get("status") ?? undefined
          return json({ referrals: listReferrals(type, status) })
        }
        if (path === "/api/mkt/referrals" && req.method === "POST") {
          const body = await readBody(req)
          const { addReferral } = await import("./crm.js")
          try { return json({ referral: addReferral(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const mktReferralMatch = path.match(/^\/api\/mkt\/referrals\/(\d+)$/)
        if (mktReferralMatch && req.method === "GET") {
          const { getReferral } = await import("./crm.js")
          const r = getReferral(Number(mktReferralMatch[1]))
          if (!r) return json({ error: "not found" }, 404)
          return json({ referral: r })
        }
        if (mktReferralMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateReferral } = await import("./crm.js")
          const r = updateReferral(Number(mktReferralMatch[1]), body)
          if (!r) return json({ error: "not found" }, 404)
          return json({ referral: r })
        }
        if (mktReferralMatch && req.method === "DELETE") {
          const { deleteReferral } = await import("./crm.js")
          return json({ ok: deleteReferral(Number(mktReferralMatch[1])) })
        }

        // ===== Referral Program =====
        if (path === "/api/referral/dashboard" && req.method === "GET") {
          const { referralDashboard } = await import("./crm.js")
          return json(referralDashboard())
        }
        if (path === "/api/referral/referrers" && req.method === "GET") {
          const { listReferrers } = await import("./crm.js")
          const tier = url.searchParams.get("tier") ?? undefined
          return json({ referrers: listReferrers(tier) })
        }
        if (path === "/api/referral/referrers" && req.method === "POST") {
          const body = await readBody(req)
          const { addReferrer } = await import("./crm.js")
          try { return json({ referrer: addReferrer(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const referrerMatch = path.match(/^\/api\/referral\/referrers\/(\d+)$/)
        if (referrerMatch && req.method === "GET") {
          const { getReferrer } = await import("./crm.js")
          const r = getReferrer(Number(referrerMatch[1]))
          if (!r) return json({ error: "not found" }, 404)
          return json({ referrer: r })
        }
        if (referrerMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateReferrer, getReferrer, recomputeReferrerTier } = await import("./crm.js")
          const r = updateReferrer(Number(referrerMatch[1]), body)
          if (!r) return json({ error: "not found" }, 404)
          recomputeReferrerTier(Number(referrerMatch[1]))
          return json({ referrer: getReferrer(Number(referrerMatch[1])) })
        }
        if (referrerMatch && req.method === "DELETE") {
          const { deleteReferrer } = await import("./crm.js")
          return json({ ok: deleteReferrer(Number(referrerMatch[1])) })
        }
        if (path === "/api/referral/events" && req.method === "GET") {
          const { listReferralEvents } = await import("./crm.js")
          const rid = url.searchParams.get("referrer_id")
          return json({ events: listReferralEvents(rid ? Number(rid) : undefined) })
        }
        if (path === "/api/referral/events" && req.method === "POST") {
          const body = await readBody(req)
          const { addReferralEvent } = await import("./crm.js")
          try { return json({ event: addReferralEvent(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const eventMatch = path.match(/^\/api\/referral\/events\/(\d+)$/)
        if (eventMatch && req.method === "DELETE") {
          const { deleteReferralEvent } = await import("./crm.js")
          return json({ ok: deleteReferralEvent(Number(eventMatch[1])) })
        }
        if (path === "/api/referral/leaderboard" && req.method === "GET") {
          const { referralLeaderboard } = await import("./crm.js")
          const limit = Number(url.searchParams.get("limit") ?? 10)
          return json({ leaderboard: referralLeaderboard(limit) })
        }
        if (path === "/api/referral/birthdays" && req.method === "GET") {
          const { upcomingReferrerBirthdays } = await import("./crm.js")
          const days = Number(url.searchParams.get("days") ?? 30)
          return json({ birthdays: upcomingReferrerBirthdays(days) })
        }
        if (path === "/api/referral/thank-yous" && req.method === "GET") {
          const { listThankYous } = await import("./crm.js")
          const rid = url.searchParams.get("referrer_id")
          return json({ thank_yous: listThankYous(rid ? Number(rid) : undefined) })
        }
        if (path === "/api/referral/thank-yous" && req.method === "POST") {
          const body = await readBody(req)
          const { addThankYou } = await import("./crm.js")
          try { return json({ thank_you: addThankYou(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const tyMatch = path.match(/^\/api\/referral\/thank-yous\/(\d+)$/)
        if (tyMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updateThankYou } = await import("./crm.js")
          const r = updateThankYou(Number(tyMatch[1]), body)
          if (!r) return json({ error: "not found" }, 404)
          return json({ thank_you: r })
        }
        if (tyMatch && req.method === "DELETE") {
          const { deleteThankYou } = await import("./crm.js")
          return json({ ok: deleteThankYou(Number(tyMatch[1])) })
        }
        if (path === "/api/referral/seed-example" && req.method === "POST") {
          const { seedReferralExample } = await import("./crm.js")
          return json(seedReferralExample())
        }
        if (path === "/api/referral/tier-recompute" && req.method === "POST") {
          const body = await readBody(req)
          const { recomputeReferrerTier } = await import("./crm.js")
          const r = recomputeReferrerTier(Number(body.referrer_id))
          return json({ referrer: r })
        }
        const referredLeadsMatch = path.match(/^\/api\/referral\/referrers\/(\d+)\/leads$/)
        if (referredLeadsMatch && req.method === "GET") {
          const { getReferredLeads } = await import("./crm.js")
          return json({ leads: getReferredLeads(Number(referredLeadsMatch[1])) })
        }
        if (path === "/api/referral/sync" && req.method === "POST") {
          const { syncReferrersFromReferrals } = await import("./crm.js")
          return json(syncReferrersFromReferrals())
        }

        // ===== People master =====
        if (path === "/api/people/search" && req.method === "GET") {
          const { listPeople } = await import("./crm.js")
          const q = (url.searchParams.get("q") || "").toLowerCase()
          const limit = Number(url.searchParams.get("limit") ?? 20)
          const all = listPeople()
          const filtered = q ? all.filter((p: any) => (p.name || "").toLowerCase().includes(q) || (p.email || "").toLowerCase().includes(q)) : all
          return json({ people: filtered.slice(0, limit) })
        }
        if (path === "/api/people" && req.method === "GET") {
          const { listPeople } = await import("./crm.js")
          const role = url.searchParams.get("role") ?? undefined
          return json({ people: listPeople(role) })
        }
        if (path === "/api/people" && req.method === "POST") {
          const body = await readBody(req)
          const { addPerson } = await import("./crm.js")
          try { return json({ person: addPerson(body) }) }
          catch (e) { return json({ error: String(e) }, 400) }
        }
        const personMatch = path.match(/^\/api\/people\/(\d+)$/)
        if (personMatch && req.method === "GET") {
          const { getPerson } = await import("./crm.js")
          const p = getPerson(Number(personMatch[1]))
          if (!p) return json({ error: "not found" }, 404)
          return json({ person: p })
        }
        if (personMatch && req.method === "PUT") {
          const body = await readBody(req)
          const { updatePerson } = await import("./crm.js")
          const p = updatePerson(Number(personMatch[1]), body)
          if (!p) return json({ error: "not found" }, 404)
          return json({ person: p })
        }
        if (path === "/api/referral/promote-client" && req.method === "POST") {
          const body = await readBody(req)
          const { promoteClientToReferrer } = await import("./crm.js")
          const r = promoteClientToReferrer(Number(body.client_id))
          if (!r) return json({ error: "not found" }, 404)
          return json({ referrer: r })
        }
        if (path === "/api/referral/promote-person" && req.method === "POST") {
          const body = await readBody(req)
          const { addPerson, getPerson, addReferrer, addRoleToPerson } = await import("./crm.js")
          let pid = body.person_id ? Number(body.person_id) : null
          if (!pid) {
            const p = addPerson({ name: body.name, email: body.email, phone: body.phone, birthday: body.birthday, roles: ["referrer"] })
            pid = p.id
          } else {
            addRoleToPerson(pid, "referrer")
          }
          const person = getPerson(pid!)
          const r = addReferrer({ name: person!.name, email: person!.email, phone: person!.phone, birthday: person!.birthday, notes: person!.notes, person_id: pid, tier: "bronze", points: 0 })
          return json({ referrer: r })
        }
        const stratMatch = path.match(/^\/api\/products\/(\d+)\/strategy$/)
        if (stratMatch && req.method === "POST") {
          const id = Number(stratMatch[1])
          const { getProduct, updateProduct } = await import("./crm.js")
          const product = getProduct(id)
          if (!product) return json({ error: "not found" }, 404)
          try {
            const prompt = buildStrategyPrompt(product)
            let reply = ""
            if (ctx) {
              try {
                if (!strategySessionId) {
                  const created = await ctx.session.create({ title: "Strategy generation" })
                  strategySessionId = created.id
                }
                await ctx.session.prompt({ sessionID: strategySessionId, text: prompt } as any)
                const deadline = Date.now() + 120000
                while (Date.now() < deadline && !reply) {
                  await new Promise((r) => setTimeout(r, 2000))
                  try {
                    const msgs = await ctx.session.context({ sessionID: strategySessionId })
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      const m = msgs[i]
                      if (m.type !== "assistant") continue
                      const text = (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\\n")
                      if (text && text.trim()) { reply = text; break }
                    }
                  } catch { /* keep polling */ }
                }
              } catch (e) {
                console.error("[strategy] engine session error:", String(e))
              }
            }
            if (!reply) {
              // Fallback to direct provider call
              try {
                const r = await directChat(prompt, "opencode-go")
                reply = r.reply
              } catch (e) {
                reply = ""
                throw new Error("Strategy generation failed: " + String(e))
              }
            }
            if (!reply) throw new Error("Strategy generation timed out or produced no output.")
            // Strip any reasoning preamble: keep from the first markdown heading onward.
            const headIdx = reply.search(/^#{1,2} /m)
            const cleaned = headIdx >= 0 ? reply.slice(headIdx).trim() : reply.trim()
            const updated = updateProduct(id, { strategy: cleaned, strategy_generated_at: new Date().toISOString() })
            return json({ product: updated, strategy: reply })
          } catch (e) {
            return json({ error: String(e) }, 500)
          }
        }
        if (path === "/api/products/summary" && req.method === "GET") {
          const { productsSummary } = await import("./crm.js")
          return json({ summary: productsSummary() })
        }
        if (path === "/api/bulk/status" && req.method === "POST") {
          const body = await readBody(req)
          const ids = (body.ids ?? []).map(Number)
          const status = String(body.status ?? "")
          const updated: number[] = []
          for (const id of ids) {
            try { updateClient(id, { status }); updated.push(id) } catch { /* skip */ }
          }
          return json({ updated: updated.length, ids: updated })
        }
        if (path === "/api/tower/batch-outbound" && req.method === "POST") {
          const body = await readBody(req)
          const rawIds = (body.ids ?? []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
          const ids = rawIds.slice(0, 20)
          const force = !!body.force
          const dispatched: number[] = []
          const skipped: number[] = []
          const failed: { id: number; reason: string }[] = []
          const blocked = new Set(["contacted", "followup_1", "followup_2", "followup_3", "yes", "done", "no"])
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            const client = getClient(id)
            if (!client) { failed.push({ id, reason: "not found" }); if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 300)); continue }
            const email = String(client.email || "").trim()
            if (!email) { skipped.push(id); if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 300)); continue }
            const lower = email.toLowerCase()
            if (lower.includes("@pec.") || lower.includes("@legalmail.")) { skipped.push(id); if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 300)); continue }
            const stage = String(client.status || "")
            if (!force && blocked.has(stage)) { skipped.push(id); if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 300)); continue }
            try {
              const { dispatchToTower } = await import("./tower.js")
              const r = await dispatchToTower(id, "outbound_prep")
              if (r.ok || r.skipped) dispatched.push(id)
              else failed.push({ id, reason: r.error || r.reason || "dispatch failed" })
            } catch (e) {
              failed.push({ id, reason: String(e) })
            }
            if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 300))
          }
          return json({ dispatched, skipped, failed })
        }
        if (path === "/api/today" && req.method === "GET") {
          const today = new Date().toISOString().slice(0, 10)
          const clients = findClients({ limit: 200 })
          const due = clients.filter((c) => (c.next_action_at && c.next_action_at.slice(0, 10) <= today))
          return json({ today, clients: due })
        }
        if (path === "/api/tasks" && req.method === "GET") {
          const q = (url.searchParams.get("q") ?? "").toLowerCase()
          const rows = crmDb().query("SELECT * FROM clients WHERE next_action IS NOT NULL AND next_action != '' ORDER BY COALESCE(next_action_at, updated_at) ASC").all() as any[]
          let clients = rows.map((r) => ({
            id: r.id, name: r.name, status: r.status, next_action: r.next_action,
            next_action_at: r.next_action_at, score: r.score, source: r.source,
          }))
          if (q) clients = clients.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.next_action || "").toLowerCase().includes(q))
          return json({ clients, total: clients.length })
        }
        if (path === "/api/settings/telegram/test" && req.method === "POST") {
          const { testTelegram } = await import("./telegram.js")
          const r = await testTelegram()
          return json(r)
        }
        if (path === "/api/debug/jobs" && req.method === "GET") {
          const jobs: any[] = []
          for (const [id, j] of enrichJobs.entries()) jobs.push({ type: "enrich", id, running: j.running, done: j.done, error: j.error ?? null, lines: j.lines })
          for (const [id, j] of scoutXJobs.entries()) jobs.push({ type: "scout-x", id, running: j.running, done: j.done, error: j.error ?? null, lines: j.lines })
          const bp = (globalThis as any).__bpJobs
          if (bp) for (const [id, j] of bp.entries()) jobs.push({ type: "batch-pipeline", id, running: j.running, done: j.done, error: j.error ?? null, lines: j.lines })
          for (const [id, j] of debugJobs.entries()) jobs.push({ type: j.type, id, running: j.running, done: j.done, error: j.error ?? null, lines: j.lines })
          return json({ jobs, logs: debugLogs.slice(-200) })
        }
        if (path === "/api/debug/logs" && req.method === "GET") {
          return json({ logs: debugLogs.slice(-200) })
        }
        if (path === "/api/outbound/run-tick" && req.method === "POST") {
          try {
            const { runOutboundLoopTick } = await import("./heartbeat.js")
            const r = await runOutboundLoopTick()
            return json(r)
          } catch (e) {
            return json({ error: String(e) }, 500)
          }
        }
        if (path === "/api/clients/update" && req.method === "POST") {
          const body = await readBody(req)
          const id = Number(body.id)
          const patch: any = {}
          for (const k of ["name","vertical","status","score","address","phone","website","email","linkedin","twitter","facebook","instagram","notes","deal_value","next_action","next_action_at","last_contact","source","language"]) {
            if (k in body) patch[k] = body[k]
          }
          const client = updateClient(id, patch)
          return json({ client })
        }
        if (path === "/api/outreach/batch-draft" && req.method === "POST") {
          const body = await readBody(req)
          const limit = Math.max(1, Math.min(50, Number(body.limit ?? 50)))
          let ids: number[] = Array.isArray(body.ids) ? body.ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0) : []
          if (!ids.length) {
            const rows = crmDb().query(`SELECT id FROM clients WHERE email IS NOT NULL AND TRIM(email) != '' AND email NOT LIKE '%@pec.%' AND email NOT LIKE '%@legalmail.%' ORDER BY CASE WHEN address LIKE '%Castelleone%' THEN 0 WHEN address LIKE '%Crema%' THEN 1 WHEN address LIKE '%Soresina%' THEN 2 WHEN address LIKE '%Cremona%' THEN 3 WHEN address LIKE '%Lodi%' THEN 4 WHEN address LIKE '%Codogno%' THEN 5 ELSE 6 END, id`).all() as any[]
            const terminal = new Set(["contacted","followup_1","followup_2","followup_3","yes","no","stale","done"])
            const inPipeline = new Set((crmDb().query("SELECT client_id FROM pipeline WHERE touch > 0").all() as any[]).map((r: any) => r.client_id))
            for (const r of rows) {
              const c = getClient(r.id)
              if (!c) continue
              if (terminal.has(c.status)) continue
              if (inPipeline.has(c.id)) continue
              ids.push(c.id)
              if (ids.length >= limit) break
            }
          }
          const drafted: number[] = []
          const skipped: number[] = []
          const failed: { id: number; reason: string }[] = []
          const { generateClientOutreachDraft } = await import("./outreach.js")
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            try {
              const r = await generateClientOutreachDraft(id)
              if (r.filePath) drafted.push(id)
              else skipped.push(id)
            } catch (e) {
              failed.push({ id, reason: String(e) })
            }
            if (i < ids.length - 1) await new Promise((res) => setTimeout(res, 250))
          }
          return json({ drafted, skipped, failed })
        }
        const genEmailMatch = path.match(/^\/api\/clients\/(\d+)\/generate-email$/)
        if (genEmailMatch && req.method === "POST") {
          const id = Number(genEmailMatch[1])
          const jobId = "genemail_" + id + "_" + Date.now()
          const job = { type: "generate-email", id: jobId, lines: [] as string[], running: true, done: false, error: undefined as string | undefined, result: undefined as any }
          debugJobs.set(jobId, job)
          const log = (l: string) => { job.lines.push(l); dbg(l) }
          try {
            log("Generate Email started for client " + id)
            const { generateClientOutreachDraft } = await import("./outreach.js")
            const r = await generateClientOutreachDraft(id)
            job.result = r
            job.done = true
            job.running = false
            log("Generated: " + (r.subject || "(no subject)"))
            if (r.filePath) log("Draft written: " + r.filePath)
            return json({ ok: true, subject: r.subject, body: r.body, filePath: r.filePath, row: r.row })
          } catch (e) {
            job.error = String(e)
            job.done = true
            job.running = false
            log("ERROR: " + String(e))
            return json({ error: String(e) }, 500)
          }
        }
        const selectOfferMatch = path.match(/^\/api\/clients\/(\d+)\/select-offer$/)
        if (selectOfferMatch && req.method === "POST") {
          const id = Number(selectOfferMatch[1])
          const body = await readBody(req)
          const { validateOfferSelection } = await import("./routing.js")
          const { getClient } = await import("./crm.js")
          const client = getClient(id)
          if (!client) return json({ error: "not found" }, 404)
          const parsed = { offer_track: body.offer_track, offer_rationale: body.offer_rationale }
          const res = validateOfferSelection(client, parsed)
          // regenerate draft + call playbook
          try {
            const { generateClientOutreachDraft } = await import("./outreach.js")
            await generateClientOutreachDraft(id)
          } catch (e) { console.error("[select-offer] draft error:", String(e)) }
          // Call playbook generation (LLM) removed; deterministic only.
          return json({ ok: true, offer_track: res.offer_track, offer_rationale: res.offer_rationale })
        }
        if (path === "/api/clients/delete" && req.method === "POST") {
          const body = await readBody(req)
          const id = Number(body.id)
          if (!Number.isFinite(id) || id <= 0) return json({ error: "invalid id" }, 400)
          const { deleteClient } = await import("./crm.js")
          const ok = deleteClient(id)
          if (!ok) return json({ error: "not found" }, 404)
          return json({ ok: true, id })
        }
        if (path === "/api/drafts/update" && req.method === "POST") {
          const body = await readBody(req)
          const id = Number(body.id)
          try {
            const { updateDraft } = await import("./outreach.js")
            const r = await updateDraft(id, { subject: body.subject, body: body.body })
            return json({ ok: true, filePath: r.filePath, row: r.row })
          } catch (e) {
            return json({ error: String(e) }, 500)
          }
        }
        const draftContentMatch = path.match(/^\/api\/drafts\/(\d+)\/content$/)
        if (draftContentMatch && req.method === "GET") {
          const id = Number(draftContentMatch[1])
          const { getPipelineRow } = await import("./outreach.js")
          const row = getPipelineRow(id)
          if (!row || !row.draft_path) return json({ error: "not found" }, 404)
          try {
            const fs = await import("node:fs")
            const text = fs.readFileSync(row.draft_path, "utf8")
            // parse subject and body
            const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
            const fm = fmMatch ? fmMatch[1] : ""
            const sm = fm.match(/^subject:\s*(.*)$/m)
            const subject = sm ? sm[1].trim() : ""
            const body = fmMatch ? fmMatch[2].trim().replace(/\n---[\s\S]*$/, "").trim() : text.trim()
            return json({ id, subject, body, path: row.draft_path })
          } catch (e) {
            return json({ error: String(e) }, 500)
          }
        }
        if (path === "/api/drafts" && req.method === "GET") {
          const rows = listPipeline({ limit: 200 }).filter((r) => r.draft_path)
          const drafts = rows.map((r) => {
            const c = getClient(r.client_id)
            let sent = false
            let createdAt = r.created_at
            try {
              const fs = require("node:fs")
              const txt = fs.readFileSync(r.draft_path as string, "utf8")
              const sm = txt.match(/^status:\s*(.+)$/m)
              if (sm && sm[1].trim().toLowerCase() === "sent") sent = true
              const cm = txt.match(/^created:\s*(.+)$/m)
              if (cm) createdAt = cm[1].trim()
            } catch {}
            return { id: r.id, client_id: r.client_id, client_name: c?.name ?? null, client_email: c?.email ?? null, client_website: c?.website ?? null, subject: r.draft_path, path: r.draft_path, approved: r.approved, sent, stage: r.stage, touch: r.touch, created_at: createdAt }
          })
          // chronological: newest first
          drafts.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
          return json({ drafts })
        }
        if (path === "/api/drafts/clear-sent" && req.method === "POST") {
          const rows = listPipeline({ limit: 200 }).filter((r) => r.draft_path)
          let cleared = 0
          for (const r of rows) {
            let sent = false
            try {
              const fs = require("node:fs")
              const txt = fs.readFileSync(r.draft_path as string, "utf8")
              const m = txt.match(/^status:\s*(.+)$/m)
              if (m && m[1].trim().toLowerCase() === "sent") sent = true
            } catch {}
            if (sent) {
              crmDb().run("UPDATE pipeline SET draft_path = NULL, updated_at = ? WHERE id = ?", [new Date().toISOString(), r.id])
              cleared++
            }
          }
          return json({ ok: true, cleared })
        }
        if (path === "/api/approve" && req.method === "POST") {
          const body = await readBody(req)
          const ids = (body.ids ?? []).map(Number)
          const rows = approveDrafts(ids)
          return json({ approved: rows.length, rows })
        }
        if (path === "/api/deny" && req.method === "POST") {
          const body = await readBody(req)
          const ids = (body.ids ?? []).map(Number)
          const { dispose } = await import("./outreach.js")
          const { crmDb } = await import("./crm.js")
          for (const id of ids) { try { dispose(id, "no"); crmDb().run("UPDATE pipeline SET draft_path = NULL, updated_at = ? WHERE id = ?", [new Date().toISOString(), id]) } catch {} }
          return json({ denied: ids.length })
        }
        if (path === "/api/send" && req.method === "POST") {
          const body = await readBody(req)
          const ids = body.ids ? body.ids.map(Number) : undefined
          const result = await sendApproved(ids)
          return json(result)
        }
        if (path === "/api/advance" && req.method === "POST") {
          const body = await readBody(req)
          const moved = advance(Number(body.id), String(body.stage), { note: body.note, asset: body.asset })
          return json(moved)
        }
        if (path === "/api/payment" && req.method === "POST") {
          const body = await readBody(req)
          const paid = recordPayment(Number(body.id), { amount: body.amount, note: body.note, invoice_path: body.invoice_path })
          return json(paid)
        }
        if (path === "/api/schedule" && req.method === "POST") {
          const body = await readBody(req)
          const booked = scheduleCall(Number(body.id), String(body.when), body.note)
          return json(booked)
        }
        if (path === "/api/scout" && req.method === "POST") {
          const body = await readBody(req)
          const loc = String(body.location ?? "")
          const q = String(body.query ?? "")
          const limit = Number(body.limit ?? 10)
          const result = await scoutBusinesses(loc, q, limit)
          // Persist the run so past scouts stay reachable (no wasted API calls).
          try {
            const runId = saveScoutRun(loc, q, limit, result.meta?.sources_used ?? [], result.businesses ?? [])
            result.run_id = runId
          } catch (e) { /* best effort */ }
          return json(result)
        }
        if (path === "/api/scout-y" && req.method === "POST") {
          const body = await readBody(req)
          const { scoutJobIntent } = await import("./scout_y.js")
          const result = await scoutJobIntent({ query: String(body.query ?? ""), location: String(body.location ?? ""), market: body.market, limit: Number(body.limit ?? 15) })
          return json(result)
        }
        if (path === "/api/scout-y/import" && req.method === "POST") {
          const body = await readBody(req)
          const leads = Array.isArray(body.leads) ? body.leads : []
          const created: number[] = []
          for (const l of leads) {
            try {
              const { client } = addClient({
                name: String(l.company_name ?? ""),
                vertical: (l.vertical || l.industry || "scout_y"),
                status: "scouted",
                score: l.intent_score ?? 50,
                address: l.address || undefined,
                phone: l.phone || undefined,
                website: l.website || undefined,
                email: l.email || undefined,
                linkedin: (l.socials || []).find((s: string) => /linkedin/i.test(s)) || undefined,
                language: l.detected_language || "en",
                notes: `[SCOUT Y - HIGH INTENT JOB SIGNAL]\\nOpen Role: ${l.job_title}\\nJob URL: ${l.job_url}\\nDetected Signals: ${(l.signals || []).join(", ")}\\nSuggested Track: ${l.recommended_track}${l.akli_relevant ? " + AKLI Team" : ""}`,
                source: "scout_y",
              })
              created.push(client.id)
              try { logInteraction(client.id, { kind: "scout_y", direction: "note", channel: "web", status: "completed", subject: `Scout Y: ${l.job_title}`, body: `Job URL: ${l.job_url}\\nSignals: ${(l.signals||[]).join(", ")}`, occurred_at: new Date().toISOString() }) } catch {}
            } catch (e) { /* best effort */ }
          }
          return json({ ok: true, created })
        }
        if (path === "/api/scout/batch-pipeline" && req.method === "POST") {
          const body = await readBody(req)
          const location = String(body.location || "").trim()
          const query = String(body.query || "").trim()
          const limit = Math.max(1, Math.min(50, Number(body.limit ?? 35)))
          const jobId = "bp_" + Date.now()
          const job: { lines: string[]; running: boolean; done: boolean; error?: string; result?: any } = { lines: [], running: true, done: false, result: null }
          ;(globalThis as any).__bpJobs = (globalThis as any).__bpJobs || new Map()
          const jobs = (globalThis as any).__bpJobs
          jobs.set(jobId, job)
          const log = (l: string) => job.lines.push(l)
          ;(async () => {
            try {
              log("Scout started")
              const { scoutBusinesses } = await import("./scouting.js")
              const res: any = await scoutBusinesses(location, query, limit)
              const businesses = res?.businesses ?? []
              log(`Scouted ${businesses.length} businesses`)
              const { addClient } = await import("./crm.js")
              const { enrichClient } = await import("./enrichment.js")
              const created: number[] = []
              // upsert
              const ids: number[] = []
              for (const b of businesses) {
                try {
                  const { client } = addClient({ name: b.name, website: b.website, phone: b.phone, address: b.address, email: b.email, source: "batch_pipeline", status: "scouted" })
                  ids.push(client.id)
                  created.push(client.id)
                } catch (e) { /* ignore */ }
              }
              log(`Upserted ${ids.length} clients`)
              // concurrent enrichment pool of 4
              const { enrichBatch } = await import("./enrichment.js")
              await enrichBatch(ids, { concurrency: 4, onProgress: log })
              log("Enrichment done")
              // generate drafts + playbooks handled inside enrichClient
              job.result = { created, count: ids.length }
              job.done = true
            } catch (e) {
              job.error = String(e)
              job.done = true
            } finally {
              job.running = false
            }
          })()
          return json({ ok: true, jobId })
        }
        if (path === "/api/scout/runs" && req.method === "GET") {
          return json({ runs: listScoutRuns() })
        }
        if (path === "/api/clients/by-source" && req.method === "GET") {
          const rows = crmDb().query("SELECT source, COUNT(*) AS n FROM clients GROUP BY source ORDER BY n DESC").all() as any[]
          return json({ by_source: rows.map((r) => ({ source: r.source, count: Number(r.n) })) })
        }
        const scoutRunMatch = path.match(/^\/api\/scout\/runs\/(\d+)$/)
        if (scoutRunMatch && req.method === "GET") {
          const run = getScoutRun(Number(scoutRunMatch[1]))
          if (!run) return json({ error: "not found" }, 404)
          return json(run)
        }
        if (scoutRunMatch && req.method === "DELETE") {
          deleteScoutRun(Number(scoutRunMatch[1]))
          return json({ ok: true })
        }
        if (path === "/api/segments" && req.method === "GET") {
          const segs = listSegments().map((s) => ({ ...s, count: countSegmentMembers(s.filter) }))
          return json({ segments: segs })
        }
        if (path === "/api/segments" && req.method === "POST") {
          const body = await readBody(req)
          const id = saveSegment(String(body.name ?? "Untitled"), body.description ?? null, body.filter ?? {})
          const seg = getSegment(id)
          return json({ segment: seg, count: countSegmentMembers(seg?.filter ?? {}) })
        }
        const segMatch = path.match(/^\/api\/segments\/(\d+)$/)
        if (segMatch && req.method === "GET") {
          const seg = getSegment(Number(segMatch[1]))
          if (!seg) return json({ error: "not found" }, 404)
          return json({ segment: seg, count: countSegmentMembers(seg.filter) })
        }
        if (segMatch && req.method === "PUT") {
          const body = await readBody(req)
          updateSegment(Number(segMatch[1]), String(body.name ?? "Untitled"), body.description ?? null, body.filter ?? {})
          const seg = getSegment(Number(segMatch[1]))
          return json({ segment: seg, count: countSegmentMembers(seg?.filter ?? {}) })
        }
        if (segMatch && req.method === "DELETE") {
          deleteSegment(Number(segMatch[1]))
          return json({ ok: true })
        }
        const segMembersMatch = path.match(/^\/api\/segments\/(\d+)\/members$/)
        if (segMembersMatch && req.method === "GET") {
          const seg = getSegment(Number(segMembersMatch[1]))
          if (!seg) return json({ error: "not found" }, 404)
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50)))
          const page = Math.max(1, Number(url.searchParams.get("page") ?? 1))
          const offset = (page - 1) * limit
          const members = listSegmentMembers(seg.filter, limit, offset)
          const total = countSegmentMembers(seg.filter)
          return json({ members, total, page, per_page: limit })
        }
        if (path === "/api/enrich" && req.method === "POST") {
          const body = await readBody(req)
          const id = Number(body.id)
          // start background job
          const job: { lines: string[]; running: boolean; done: boolean; error?: string; result?: any } = { lines: [], running: true, done: false }
          enrichJobs.set(id, job)
          ;(async () => {
            try {
              const result = await enrichClient(id, { onProgress: (line) => { job.lines.push(line) } })
              job.result = result
              job.done = true
              job.running = false
              if (!result?.ok && result?.error) { job.error = result.error; job.lines.push("ERROR: " + result.error) }
              else { job.lines.push("Enrichment complete.") }
            } catch (e) {
              job.error = String(e)
              job.done = true
              job.running = false
              job.lines.push("ERROR: " + String(e))
            }
          })()
          return json({ started: true, client_id: id })
        }
        const enrichStatusMatch = path.match(/^\/api\/enrich\/status\/(\d+)$/)
        if (enrichStatusMatch && req.method === "GET") {
          const id = Number(enrichStatusMatch[1])
          const job = enrichJobs.get(id)
          if (!job) return json({ running: false, done: false, lines: [] })
          return json({ running: job.running, done: job.done, error: job.error ?? null, result: job.result ?? null, lineCount: job.lines.length })
        }
        const enrichLogMatch = path.match(/^\/api\/enrich\/log\/(\d+)$/)
        if (enrichLogMatch && req.method === "GET") {
          const id = Number(enrichLogMatch[1])
          const after = Number(url.searchParams.get("after") ?? 0)
          const job = enrichJobs.get(id)
          const lines = job ? job.lines.slice(after) : []
          return json({ lines, total: job ? job.lines.length : 0, running: job?.running ?? false, done: job?.done ?? false, error: job?.error ?? null })
        }
        if (path === "/api/knowledge" && req.method === "GET") {
          const { listKnowledge, memorySearch } = await import("./memory.js")
          const q = url.searchParams.get("q") ?? ""
          if (q) return json({ query: q, results: memorySearch(q) })
          const items = listKnowledge(Number(url.searchParams.get("limit") ?? 50))
          return json({ items })
        }
        if (path === "/api/knowledge" && req.method === "POST") {
          const body = await readBody(req)
          const { memoryCreate } = await import("./memory.js")
          const content = String(body.content ?? "")
          if (!content.trim()) return json({ error: "content required" }, 400)
          const tags = Array.isArray(body.tags) ? body.tags : (typeof body.tags === "string" ? body.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [])
          const title = String(body.title ?? "").trim()
          const full = title ? ("# " + title + "\n\n" + content) : content
          const id = memoryCreate(full, { memoryType: "semantic", importance: Number(body.importance ?? 0.8), tags: ["knowledge", ...tags] })
          return json({ id, title, tags })
        }
        const knowledgeMatch = path.match(/^\/api\/knowledge\/(.+)$/)
        if (knowledgeMatch && req.method === "DELETE") {
          const { deleteKnowledge } = await import("./memory.js")
          return json({ ok: deleteKnowledge(decodeURIComponent(knowledgeMatch[1])) })
        }
        if (path === "/api/knowledge/upload" && req.method === "POST") {
          const body = await readBody(req)
          const { memoryCreate } = await import("./memory.js")
          const text = String(body.text ?? "")
          const name = String(body.name ?? "uploaded")
          if (!text.trim()) return json({ error: "text required" }, 400)
          const chunks: string[] = []
          let cur = ""
          for (const para of text.split(/\n\n+/)) {
            if ((cur + para).length > 1500 && cur) { chunks.push(cur.trim()); cur = para } else { cur = cur ? cur + "\n\n" + para : para }
          }
          if (cur.trim()) chunks.push(cur.trim())
          const ids: string[] = []
          for (let i = 0; i < chunks.length; i++) {
            const id = memoryCreate("# " + name + " (part " + (i + 1) + "/" + chunks.length + ")\n\n" + chunks[i], { memoryType: "semantic", importance: 0.8, tags: ["knowledge", name] })
            ids.push(id)
          }
          return json({ name, chunks: chunks.length, ids })
        }
        if (path === "/api/enrich-domains" && req.method === "POST") {
          const body = await readBody(req)
          const limit = Math.max(1, Math.min(200, Number(body.limit ?? 25)))
          const onlyMissing = body.only_missing !== false
          const free = new Set(["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","live.com","aol.com","mail.com","protonmail.com","gmx.com","yandex.com","me.com","msn.com","googlemail.com","hotmail.co.uk","yahoo.co.uk"])
          const rows = crmDb().query("SELECT DISTINCT email FROM clients WHERE email IS NOT NULL AND email != ''" + (onlyMissing ? " AND (website IS NULL OR website = '')" : "")).all() as any[]
          const domains = new Set<string>()
          for (const r of rows) {
            const e = String(r.email || "")
            const at = e.indexOf("@")
            if (at < 0) continue
            const d = e.slice(at + 1).toLowerCase().trim()
            if (!d || free.has(d)) continue
            domains.add(d)
          }
          const domainList = Array.from(domains).slice(0, limit)
          let enriched = 0
          let failed = 0
          const details: { domain: string; status: string; title?: string }[] = []
          for (const domain of domainList) {
            let info: { title?: string; description?: string; siteName?: string; live: boolean } = { live: false }
            for (const scheme of ["https", "http"]) {
              try {
                const controller = new AbortController()
                const to = setTimeout(() => controller.abort(), 8000)
                const res = await fetch(scheme + "://" + domain, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; ElitzaEnrich/1.0)" }, redirect: "follow" })
                clearTimeout(to)
                if (!res.ok) continue
                const html = await res.text()
                info.live = true
                const titleM = html.match(/<title[^>]*>([^<]*)<\/title>/i)
                if (titleM) info.title = titleM[1].trim()
                const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
                if (descM) info.description = descM[1].trim()
                const ogSite = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i)
                if (ogSite) info.siteName = ogSite[1].trim()
                const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
                if (!info.title && ogTitle) info.title = ogTitle[1].trim()
                break
              } catch { /* try next scheme */ }
            }
            if (!info.live) { failed++; details.push({ domain, status: "unreachable" }); continue }
            const company = info.siteName || info.title || domain
            const website = "https://" + domain
            const noteLine = "Domain enrichment: " + company + (info.description ? " — " + info.description.slice(0, 200) : "")
            const clients = crmDb().query("SELECT id, notes FROM clients WHERE email LIKE ?").all("%@" + domain) as any[]
            for (const c of clients) {
              const existing = c.notes || ""
              const newNotes = existing ? existing + "\n" + noteLine : noteLine
              crmDb().run("UPDATE clients SET website = COALESCE(NULLIF(website,''), ?), company = COALESCE(NULLIF(company,''), ?), notes = ?, updated_at = ? WHERE id = ?", [website, company, newNotes, new Date().toISOString(), c.id])
            }
            enriched++
            details.push({ domain, status: "enriched", title: company })
          }
          return json({ processed: domainList.length, enriched, failed, total_domains: domains.size, details })
        }
        if (path === "/api/where" && req.method === "POST") {
          const body = await readBody(req)
          const w = productionState(Number(body.id))
          return json(w)
        }
        if (path === "/api/log" && req.method === "POST") {
          const body = await readBody(req)
          const { logInteraction } = await import("./crm.js")
          const interaction = logInteraction(Number(body.id), {
            kind: String(body.kind ?? "note"),
            direction: body.direction,
            channel: body.channel,
            status: body.status,
            subject: body.subject,
            body: body.body,
            occurred_at: body.occurred_at,
          })
          return json({ interaction })
        }
        if (path === "/api/asset" && req.method === "POST") {
          const body = await readBody(req)
          const filePath = String(body.path ?? "")
          // Only read files under the Elitza home or /tmp (safety).
          const home = process.env.HOME ?? ""
          const allowed = [`${home}/.ai-enablement-agent`, "/tmp", `${home}/.openclaw`]
          if (!allowed.some((root) => filePath.startsWith(root))) {
            return json({ error: "path not allowed" }, 403)
          }
          try {
            const content = await Bun.file(filePath).text()
            return json({ path: filePath, content })
          } catch (e) {
            return json({ error: String(e) }, 404)
          }
        }

        if (path === "/api/tags" && req.method === "GET") {
          const { allTags, listTags } = await import("./crm.js")
          const clientId = url.searchParams.get("client_id")
          if (clientId) return json({ tags: listTags(Number(clientId)) })
          return json({ tags: allTags() })
        }
        if (path === "/api/tags/add" && req.method === "POST") {
          const body = await readBody(req)
          const { addTag } = await import("./crm.js")
          addTag(Number(body.client_id), String(body.tag ?? ""))
          return json({ ok: true })
        }
        if (path === "/api/tags/remove" && req.method === "POST") {
          const body = await readBody(req)
          const { removeTag } = await import("./crm.js")
          removeTag(Number(body.client_id), String(body.tag ?? ""))
          return json({ ok: true })
        }
        if (path === "/api/deals" && req.method === "GET") {
          const { listDeals } = await import("./crm.js")
          const clientId = url.searchParams.get("client_id")
          const deals = listDeals(clientId ? Number(clientId) : undefined)
          return json({ deals })
        }
        if (path === "/api/deals" && req.method === "POST") {
          const body = await readBody(req)
          const { addDeal } = await import("./crm.js")
          const deal = addDeal(Number(body.client_id), { title: String(body.title ?? "Deal"), stage: body.stage, value: body.value !== undefined ? Number(body.value) : undefined, probability: body.probability !== undefined ? Number(body.probability) : undefined, close_date: body.close_date, notes: body.notes })
          return json({ deal })
        }
        if (path === "/api/deals/update" && req.method === "POST") {
          const body = await readBody(req)
          const { updateDeal } = await import("./crm.js")
          const deal = updateDeal(Number(body.id), { title: body.title, stage: body.stage, value: body.value !== undefined ? Number(body.value) : undefined, probability: body.probability !== undefined ? Number(body.probability) : undefined, close_date: body.close_date, notes: body.notes })
          return json({ deal })
        }
        if (path === "/api/deals/delete" && req.method === "POST") {
          const body = await readBody(req)
          const { deleteDeal } = await import("./crm.js")
          deleteDeal(Number(body.id))
          return json({ ok: true })
        }
        if (path === "/api/cloud" && req.method === "GET") {
          const { listCloudAccounts } = await import("./crm.js")
          const accs = listCloudAccounts().map((a: any) => ({ id: a.id, provider: a.provider, account_label: a.account_label, status: a.status, last_sync: a.last_sync, last_error: a.last_error }))
          return json({ accounts: accs })
        }
        if (path === "/api/cloud/connect" && req.method === "POST") {
          const body = await readBody(req)
          const { connectCloud } = await import("./crm.js")
          const acc = connectCloud(String(body.provider ?? ""), String(body.access_token ?? ""), body.refresh_token ? String(body.refresh_token) : undefined, body.label ? String(body.label) : undefined)
          return json({ account: acc })
        }
        if (path === "/api/cloud/disconnect" && req.method === "POST") {
          const body = await readBody(req)
          const { disconnectCloud } = await import("./crm.js")
          disconnectCloud(Number(body.id))
          return json({ ok: true })
        }
        if (path === "/api/cloud/sync" && req.method === "POST") {
          const { continuousBackupStream } = await import("./crm.js")
          const r = await continuousBackupStream()
          return json(r)
        }
        if (path === "/api/drive/accounts" && req.method === "GET") {
          const accs = crmDb().query("SELECT id, provider, account_label, status FROM cloud_accounts WHERE provider IN ('google','gdrive')").all() as any[]
          return json({ accounts: accs })
        }
        if (path === "/api/drive/files" && req.method === "GET") {
          const accountId = Number(url.searchParams.get("account_id"))
          const folderId = url.searchParams.get("folder_id") || "root"
          const acc = crmDb().query("SELECT access_token FROM cloud_accounts WHERE id = ?").get(accountId) as any
          if (!acc) return json({ error: "account not found" }, 404)
          const q = folderId === "root" ? "" : "'" + folderId + "' in parents and trashed=false"
          const params = new URLSearchParams({ pageSize: "50", fields: "files(id,name,mimeType,webViewLink,modifiedTime,size,parents)" })
          if (q) params.set("q", q)
          const r = await fetch("https://www.googleapis.com/drive/v3/files?" + params.toString(), { headers: { "Authorization": "Bearer " + acc.access_token } })
          const data = await r.json() as any
          if (!r.ok) return json({ error: data?.error?.message || ("drive " + r.status) }, r.status)
          return json({ files: data.files || [], folder_id: folderId })
        }
        if (path === "/api/drive/attach" && req.method === "POST") {
          const body = await readBody(req)
          const accountId = Number(body.account_id)
          const fileId = String(body.file_id ?? "")
          const clientId = Number(body.client_id)
          const acc = crmDb().query("SELECT access_token FROM cloud_accounts WHERE id = ?").get(accountId) as any
          if (!acc) return json({ error: "account not found" }, 404)
          const r = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?fields=id,name,mimeType,webViewLink", { headers: { "Authorization": "Bearer " + acc.access_token } })
          const f = await r.json() as any
          if (!r.ok) return json({ error: f?.error?.message || ("drive " + r.status) }, r.status)
          const { addAsset } = await import("./crm.js")
          addAsset(clientId, { kind: "drive", name: f.name || fileId, path: f.webViewLink || ("https://drive.google.com/file/d/" + fileId), notes: f.mimeType || "" })
          return json({ ok: true, file: f })
        }
        if (path === "/api/revenue" && req.method === "GET") {
          const { revenueStats } = await import("./crm.js")
          return json(revenueStats())
        }
        if (path === "/api/digest" && req.method === "GET") {
          const { weeklyDigest } = await import("./crm.js")
          return json({ markdown: weeklyDigest() })
        }
        if (path === "/api/chat" && req.method === "POST") {
          const body = await readBody(req)
          const text = String(body.text ?? body.message ?? "")
          if (!text.trim()) return json({ error: "text required" }, 400)
          const provider = "opencode-go"
          const modelOverride = String(body.model ?? "")
          const variantOverride = String(body.variant ?? "")
          // Try engine session first
          let reply = ""
          let thinking = ""
          if (ctx) {
            try {
              if (!chatSessionId) {
                const created = await ctx.session.create({ title: "CRM chat" })
                chatSessionId = created.id
              }
              const page = body.page ? String(body.page) : null
              const pageCtx = page ? `\\n\\n[Context: user is currently on the "${page}" page of the CRM.]` : ""
              await ctx.session.prompt({ sessionID: chatSessionId, text: text + pageCtx } as any)
              await new Promise((r) => setTimeout(r, 3000))
              const msgs = await ctx.session.context({ sessionID: chatSessionId })
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i]
                if (m.type !== "assistant") continue
                reply = (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\\n")
                break
              }
            } catch (e) { reply = ""; console.error("[crm-chat] engine session error:", String(e)) }
          }
          if (!reply || reply === "(no response)") {
            try {
              const r = await directChat(text, provider, modelOverride || undefined, variantOverride || undefined)
              reply = r.reply
              thinking = r.thinking
            } catch (e) { reply = "Error: " + String(e); console.error("[crm-chat] directChat error:", String(e)) }
          }
          return json({ reply: reply || "(no response)", thinking })
        }
        if (path === "/api/server/reboot" && req.method === "POST") {
          try { logAudit("server", 0, "reboot_requested", "user-initiated") } catch {}
          // Respond first, then exit so systemd (Restart=always) brings it back.
          setTimeout(() => { try { process.exit(0) } catch {} }, 700)
          return json({ ok: true, message: "rebooting" })
        }
        if (path === "/api/server/status" && req.method === "GET") {
          return json({ ok: true, uptime: process.uptime(), pid: process.pid })
        }

        if (path === "/api/autofarm/status" && req.method === "GET") {
          const { ensureAppSettingsTable, getAppSetting } = await import("./crm.js")
          ensureAppSettingsTable()
          const enabled = getAppSetting("autofarm_enabled") === "1"
          // pending drafts
          let pending = 0
          try {
            const rows = crmDb().query("SELECT COUNT(*) as c FROM pipeline WHERE approved = 0 AND draft_path IS NOT NULL").get() as any
            pending = rows?.c ?? 0
          } catch {}
          // dispatched today
          let dispatchedToday = 0
          try {
            const today = new Date().toISOString().slice(0, 10)
            const rows = crmDb().query("SELECT COUNT(*) as c FROM autofarm_dispatch_log WHERE substr(dispatched_at,1,10) = ?").get(today) as any
            dispatchedToday = rows?.c ?? 0
          } catch {}
          // updated_at
          let updatedAt: string | null = null
          try {
            const row = crmDb().query("SELECT updated_at FROM app_settings WHERE key = 'autofarm_enabled'").get() as any
            updatedAt = row?.updated_at ?? null
          } catch {}
          return json({ enabled, pending_drafts: pending, target_queue: 100, dispatched_today: dispatchedToday, daily_cap: 115, updated_at: updatedAt })
        }
        if (path === "/api/autofarm/toggle" && req.method === "POST") {
          const { ensureAppSettingsTable, getAppSetting, setAppSetting } = await import("./crm.js")
          ensureAppSettingsTable()
          const body = await readBody(req)
          let enabled: boolean
          if (body && typeof body.enabled === "boolean") {
            enabled = body.enabled
          } else {
            enabled = !(getAppSetting("autofarm_enabled") === "1")
          }
          setAppSetting("autofarm_enabled", enabled ? "1" : "0")
          // If enabled, kick off an immediate background run so the user sees activity.
          if (enabled) {
            try {
              const { spawn } = await import("node:child_process")
              const fs = await import("node:fs")
              const logFd = fs.openSync("/tmp/opencode/autofarm.log", "a")
              const child = spawn("python3", ["/home/dario/workspace-v2/products/personal-crm-dario/scripts/autofarm_local.py"], {
                detached: true,
                stdio: ["ignore", logFd, logFd],
                env: { ...process.env },
              })
              child.unref()
            } catch (e) { /* best effort */ }
          }
          // return updated status
          const pending = (crmDb().query("SELECT COUNT(*) as c FROM pipeline WHERE approved = 0 AND draft_path IS NOT NULL").get() as any)?.c ?? 0
          const today = new Date().toISOString().slice(0, 10)
          const dispatchedToday = (crmDb().query("SELECT COUNT(*) as c FROM autofarm_dispatch_log WHERE substr(dispatched_at,1,10) = ?").get(today) as any)?.c ?? 0
          const updatedAt = (crmDb().query("SELECT updated_at FROM app_settings WHERE key = 'autofarm_enabled'").get() as any)?.updated_at ?? null
          return json({ enabled, pending_drafts: pending, target_queue: 100, dispatched_today: dispatchedToday, daily_cap: 115, updated_at: updatedAt })
        }

        // ---- Mail ----
        if (path === "/api/emails" && req.method === "GET") {
          const folder = url.searchParams.get("folder") || undefined
          const q = url.searchParams.get("q") || undefined
          const clientId = url.searchParams.get("client_id")
          const emails = listEmails({ folder, q: q || undefined, client_id: clientId ? Number(clientId) : undefined, limit: 200 })
          return json({ emails, counts: emailCounts() })
        }
        if (path === "/api/emails/counts" && req.method === "GET") {
          return json(emailCounts())
        }
        const emailMatch = path.match(/^\/api\/emails\/(\d+)$/)
        if (emailMatch && req.method === "GET") {
          const id = Number(emailMatch[1])
          const e = getEmail(id)
          if (!e) return json({ error: "not found" }, 404)
          // mark read on open
          if (e.folder === "inbox" && !e.is_read) updateEmail(id, { is_read: 1 })
          return json({ email: getEmail(id) })
        }
        if (emailMatch && req.method === "POST") {
          const id = Number(emailMatch[1])
          const body = await readBody(req)
          const updated = updateEmail(id, body || {})
          if (!updated) return json({ error: "not found" }, 404)
          return json({ email: updated })
        }
        if (emailMatch && req.method === "DELETE") {
          const id = Number(emailMatch[1])
          const e = getEmail(id)
          if (!e) return json({ error: "not found" }, 404)
          if (e.folder === "trash") {
            deleteEmail(id)
            return json({ ok: true, permanent: true })
          }
          const updated = moveEmail(id, "trash")
          return json({ email: updated })
        }
        if (path === "/api/emails/match" && req.method === "GET") {
          const addr = url.searchParams.get("email") || ""
          const c = findClientByEmail(addr)
          return json({ client: c })
        }
        if (path === "/api/emails/send" && req.method === "POST") {
          const body = await readBody(req)
          const to = String(body.to || "").trim()
          const subject = String(body.subject || "").trim()
          let text = String(body.body || "")
          // append signature if configured
          try {
            const { soulGet } = await import("./soul.js")
            const sig = soulGet("mail_signature", "")
            if (sig && !text.includes(sig)) text = text + "\\n\\n" + sig
          } catch {}
          const cc = body.cc ? String(body.cc).trim() : null
          const bcc = body.bcc ? String(body.bcc).trim() : null
          if (!to) return json({ error: "recipient required" }, 400)
          // resolve client
          let clientId: number | null = body.client_id ? Number(body.client_id) : null
          // auto-link only if enabled in settings
          let autoLink = true
          try { const { soulGet } = await import("./soul.js"); autoLink = soulGet("mail_auto_link", "true") !== "false" } catch {}
          if (!clientId && autoLink) {
            const c = findClientByEmail(to)
            if (c) clientId = c.id
          }
          const client = clientId ? getClient(clientId) : null
          const company = client?.company ?? null
          const threadId = body.thread_id ? String(body.thread_id) : null
          const isDraft = body.send !== true
          const now = new Date().toISOString()
          let resendId: string | null = null
          const apiKey = process.env.RESEND_API_KEY?.trim()
          const from = process.env.RESEND_FROM?.trim()
          if (!isDraft && (!apiKey || !from)) return json({ error: "RESEND_API_KEY / RESEND_FROM not set" }, 400)
          if (!isDraft) {
            try {
              const resp = await fetch((process.env.RESEND_URL || "https://api.resend.com/emails").replace(/\/$/, ""), {
                method: "POST",
                headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ from, to: [to], cc: cc ? [cc] : undefined, bcc: bcc ? [bcc] : undefined, subject, text }),
                signal: AbortSignal.timeout(15000),
              })
              if (!resp.ok) {
                const detail = (await resp.text()).slice(0, 300)
                return json({ error: "Resend HTTP " + resp.status + ": " + detail }, 502)
              }
              const j = await resp.json() as any
              resendId = j?.id ?? null
            } catch (e) {
              return json({ error: String(e) }, 502)
            }
          }
          const email = createEmail({
            folder: isDraft ? "drafts" : "sent",
            direction: "out",
            from_addr: process.env.RESEND_FROM?.trim() || undefined,
            to_addr: to,
            cc: cc ?? undefined,
            bcc: bcc ?? undefined,
            subject,
            body: text,
            occurred_at: now,
            client_id: clientId,
            company: company ?? undefined,
            thread_id: threadId ?? undefined,
            resend_id: resendId ?? undefined,
            is_read: 1,
          })
          // if replying, link thread
          if (body.in_reply_to) {
            const orig = getEmail(Number(body.in_reply_to))
            if (orig) {
              if (!email.thread_id) updateEmail(email.id, { thread_id: orig.thread_id || String(orig.id) })
              // mark original read
              updateEmail(Number(body.in_reply_to), { is_read: 1 })
            }
          }
          // log interaction to client
          if (!isDraft && clientId) {
            try {
              const { logInteraction } = await import("./crm.js")
              logInteraction(clientId, {
                kind: "email_sent",
                direction: "out",
                channel: "email",
                status: "sent",
                subject,
                body: text,
                occurred_at: now,
              })
            } catch {}
          }
          return json({ email: getEmail(email.id), counts: emailCounts() })
        }
        if (path === "/api/mail/inbound" && req.method === "POST") {
          const body = await readBody(req)
          // Resend inbound webhook shape (best-effort): { from, to, subject, text, html, ... }
          const from = String(body.from || body.sender || "").trim()
          const to = Array.isArray(body.to) ? body.to.join(", ") : String(body.to || "").trim()
          const subject = String(body.subject || "").trim()
          const text = String(body.text || body.body || body.plain || "")
          const html = body.html ? String(body.html) : null
          let autoLink = true
          try { const { soulGet } = await import("./soul.js"); autoLink = soulGet("mail_auto_link", "true") !== "false" } catch {}
          const client = autoLink ? (findClientByEmail(from) || findClientByEmail(to)) : null
          const email = createEmail({
            folder: "inbox",
            direction: "in",
            from_addr: from || undefined,
            to_addr: to || undefined,
            subject,
            body: text,
            html: html ?? undefined,
            occurred_at: body.date ? String(body.date) : new Date().toISOString(),
            client_id: client?.id ?? null,
            company: client?.company ?? undefined,
            is_read: 0,
          })
          if (client) {
            try {
              const { logInteraction, updateClient } = await import("./crm.js")
              logInteraction(client.id, {
                kind: "email_received",
                direction: "in",
                channel: "email",
                status: "received",
                subject,
                body: text,
                occurred_at: email.occurred_at,
              })
              // stop pending follow-ups and advance stage
              try {
                const st = client.status
                if (st === "contacted" || String(st || "").startsWith("followup")) {
                  updateClient(client.id, { status: "yes" })
                }
              } catch {}
            } catch {}
            // Fire-and-forget Tower inbound hook (never blocks mail route).
            try {
              const { dispatchToTower } = await import("./tower.js")
              void dispatchToTower(client.id, "inbound_received", { email_id: email.id, from, subject, snippet: text.slice(0, 1500) }).catch(() => {})
            } catch {}
            // Email-to-calendar reasoning + Telegram alert (fire-and-forget)
            void (async () => {
              try {
                const { extractAndBookMeeting } = await import("./calendar.js")
                const meeting = await extractAndBookMeeting(email, client, text)
                const { buildTelegramAlert, sendTelegram } = await import("./telegram.js")
                const calStatus = meeting.meeting_confirmed ? `Booked ${meeting.startISO}` : "No meeting detected"
                const alert = buildTelegramAlert({ clientName: client.name, vertical: client.vertical, offer: client.offer_track, snippet: text, calendarStatus: calStatus, link: `http://127.0.0.1:8800/#client-${client.id}` })
                await sendTelegram(alert)
              } catch (e) { console.error("[inbound] telegram/calendar error:", String(e)) }
            })()
          }
          return json({ email, counts: emailCounts() })
        }

        // ---- Gmail (Google Workspace) integration ----
        if (path === "/api/mail/gmail/accounts" && req.method === "GET") {
          const accs = crmDb().query("SELECT id, provider, account_label, status, last_sync, last_error FROM cloud_accounts WHERE provider = 'gmail'").all() as any[]
          return json({ accounts: accs })
        }
        if (path === "/api/mail/gmail/connect" && req.method === "POST") {
          const body = await readBody(req)
          const token = String(body.access_token || "").trim()
          if (!token) return json({ error: "access_token required" }, 400)
          const label = String(body.label || body.email || "Google Workspace").trim()
          const { connectCloud } = await import("./crm.js")
          const acc = connectCloud("gmail", token, body.refresh_token ? String(body.refresh_token) : undefined, label)
          return json({ account: acc })
        }
        if (path === "/api/mail/gmail/disconnect" && req.method === "POST") {
          const body = await readBody(req)
          const { disconnectCloud } = await import("./crm.js")
          disconnectCloud(Number(body.id))
          return json({ ok: true })
        }
        if (path === "/api/mail/gmail/sync" && req.method === "POST") {
          const body = await readBody(req)
          const accountId = Number(body.account_id)
          const acc = crmDb().query("SELECT * FROM cloud_accounts WHERE id = ? AND provider = 'gmail'").get(accountId) as any
          if (!acc) return json({ error: "account not found" }, 404)
          let token = acc.access_token
          // refresh if needed
          const probe = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { "Authorization": "Bearer " + token } })
          if (probe.status === 401) {
            const nt = await refreshGmailToken(acc)
            if (nt) token = nt
          }
          const max = Math.min(100, Number(body.limit ?? 50))
          const labels = Array.isArray(body.labels) ? body.labels : ["INBOX", "SENT", "DRAFT", "TRASH", "STARRED"]
          let imported = 0
          try {
            // list message ids per label
            const seen = new Set<string>()
            const msgIds: string[] = []
            for (const lab of labels) {
              const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=" + encodeURIComponent(lab) + "&maxResults=" + max, { headers: { "Authorization": "Bearer " + token } })
              if (!listRes.ok) continue
              const lj = await listRes.json() as any
              for (const m of (lj.messages || [])) { if (!seen.has(m.id)) { seen.add(m.id); msgIds.push(m.id) } }
            }
            // fetch each
            for (const mid of msgIds.slice(0, max * 2)) {
              const existing = crmDb().query("SELECT id FROM emails WHERE gmail_id = ?").get(mid) as any
              if (existing) continue
              const mRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(mid) + "?format=full", { headers: { "Authorization": "Bearer " + token } })
              if (!mRes.ok) continue
              const m = await mRes.json() as any
              const headers = (m.payload?.headers || []) as any[]
              const getH = (name: string) => headers.find((h: any) => (h.name || "").toLowerCase() === name.toLowerCase())?.value || ""
              const from = getH("From")
              const to = getH("To")
              const cc = getH("Cc")
              const subject = getH("Subject")
              const date = getH("Date")
              // body
              let text = ""
              let html: string | null = null
              const parts = m.payload?.parts || [m.payload]
              function walk(p: any) {
                if (!p) return
                if (p.mimeType === "text/plain" && p.body?.data) text += Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
                if (p.mimeType === "text/html" && p.body?.data) html = Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
                for (const sp of (p.parts || [])) walk(sp)
                if (!p.parts && p.body?.data && p.mimeType?.startsWith("text/")) {
                  const dec = Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
                  if (p.mimeType === "text/html") html = dec; else if (!text) text = dec
                }
              }
              for (const p of parts) walk(p)
              if (!text && m.snippet) text = m.snippet
              const labelIds: string[] = m.labelIds || []
              let folder = "inbox"
              if (labelIds.includes("SENT")) folder = "sent"
              else if (labelIds.includes("DRAFT")) folder = "drafts"
              else if (labelIds.includes("TRASH")) folder = "trash"
              else if (labelIds.includes("SPAM")) folder = "spam"
              const isStarred = labelIds.includes("STARRED") ? 1 : 0
              const isUnread = !labelIds.includes("UNREAD") ? 1 : 0
              const occurred = date ? new Date(date).toISOString() : new Date(Number(m.internalDate || Date.now())).toISOString()
              const autoLink = true
              let client = null
              try { const { soulGet } = await import("./soul.js"); if (soulGet("mail_auto_link", "true") !== "false") client = findClientByEmail(from) } catch {}
              const { createEmail, logInteraction } = await import("./crm.js")
              const email = createEmail({
                folder,
                direction: labelIds.includes("SENT") ? "out" : "in",
                from_addr: from || undefined,
                to_addr: to || undefined,
                cc: cc || undefined,
                subject: subject || undefined,
                body: text || m.snippet || "",
                html: html ?? undefined,
                occurred_at: occurred,
                client_id: client?.id ?? null,
                company: client?.company ?? undefined,
                gmail_id: mid,
                provider: "gmail",
                is_read: isUnread,
                is_starred: isStarred,
              })
              imported++
              if (client && !labelIds.includes("SENT")) {
                try { logInteraction(client.id, { kind: "email_received", direction: "in", channel: "email", status: "received", subject, body: text || m.snippet || "", occurred_at: occurred }) } catch {}
                // Fire-and-forget Tower inbound hook, only for recent emails (avoid backfill spam).
                try {
                  const occurredMs = Date.parse(occurred)
                  const sevenDays = 7 * 24 * 60 * 60 * 1000
                  if (Number.isFinite(occurredMs) && (Date.now() - occurredMs) <= sevenDays) {
                    const { dispatchToTower } = await import("./tower.js")
                    void dispatchToTower(client.id, "inbound_received", { from, subject, snippet: (text || m.snippet || "").slice(0, 1500) }).catch(() => {})
                  }
                } catch {}
              }
            }
            crmDb().run("UPDATE cloud_accounts SET last_sync = ?, last_error = NULL, status = 'connected' WHERE id = ?", [new Date().toISOString(), accountId])
          } catch (e) {
            crmDb().run("UPDATE cloud_accounts SET last_error = ?, status = 'error' WHERE id = ?", [String(e), accountId])
            return json({ error: String(e), imported }, 502)
          }
          return json({ ok: true, imported, counts: emailCounts() })
        }
        if (path === "/api/mail/gmail/send" && req.method === "POST") {
          const body = await readBody(req)
          const accountId = Number(body.account_id)
          const acc = crmDb().query("SELECT * FROM cloud_accounts WHERE id = ? AND provider = 'gmail'").get(accountId) as any
          if (!acc) return json({ error: "gmail account not found" }, 404)
          let token = acc.access_token
          const probe = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { "Authorization": "Bearer " + token } })
          if (probe.status === 401) {
            const nt = await refreshGmailToken(acc)
            if (nt) token = nt
          }
          const to = String(body.to || "").trim()
          const subject = String(body.subject || "").trim()
          let text = String(body.body || "")
          const cc = body.cc ? String(body.cc).trim() : ""
          const bcc = body.bcc ? String(body.bcc).trim() : ""
          if (!to) return json({ error: "recipient required" }, 400)
          // signature
          try { const { soulGet } = await import("./soul.js"); const sig = soulGet("mail_signature", ""); if (sig && !text.includes(sig)) text = text + "\\n\\n" + sig } catch {}
          // build RFC2822
          const from = acc.account_label || ""
          const lines = [
            "From: " + from,
            "To: " + to,
            cc ? "Cc: " + cc : "",
            bcc ? "Bcc: " + bcc : "",
            "Subject: " + subject,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=UTF-8",
            "",
            text,
          ].filter(Boolean)
          const raw = Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
          const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ raw }),
            signal: AbortSignal.timeout(20000),
          })
          if (!resp.ok) {
            const detail = (await resp.text()).slice(0, 300)
            return json({ error: "Gmail HTTP " + resp.status + ": " + detail }, 502)
          }
          const j = await resp.json() as any
          let clientId: number | null = body.client_id ? Number(body.client_id) : null
          try { const { soulGet } = await import("./soul.js"); const autoLink = soulGet("mail_auto_link", "true") !== "false"; if (!clientId && autoLink) { const c = findClientByEmail(to); if (c) clientId = c.id } } catch {}
          const client = clientId ? getClient(clientId) : null
          const { createEmail, logInteraction } = await import("./crm.js")
          const email = createEmail({
            folder: "sent",
            direction: "out",
            from_addr: from || undefined,
            to_addr: to,
            cc: cc || undefined,
            bcc: bcc || undefined,
            subject,
            body: text,
            occurred_at: new Date().toISOString(),
            client_id: clientId,
            company: client?.company ?? undefined,
            gmail_id: j?.id ?? undefined,
            provider: "gmail",
            is_read: 1,
          })
          if (clientId) {
            try { logInteraction(clientId, { kind: "email_sent", direction: "out", channel: "email", status: "sent", subject, body: text, occurred_at: email.occurred_at }) } catch {}
          }
          return json({ email: getEmail(email.id), counts: emailCounts() })
        }

        // ---- Google OAuth (one-click login) for Gmail ----
        if (path === "/api/mail/gmail/oauth-config" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          const envPath = pathMod.join(home, ".env")
          let env: Record<string, string> = {}
          try { for (const line of fs.readFileSync(envPath, "utf8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue; env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim() } } catch {}
          return json({ client_id: env["GOOGLE_CLIENT_ID"] || "", client_secret_set: !!env["GOOGLE_CLIENT_SECRET"], redirect_uri: "http://127.0.0.1:" + (process.env.CRM_VIEW_PORT ?? 8800) + "/oauth/google/callback" })
        }
        if (path === "/api/mail/gmail/oauth-config" && req.method === "POST") {
          const body = await readBody(req)
          const cid = String(body.client_id || "").trim()
          const csecret = String(body.client_secret || "").trim()
          if (!cid) return json({ error: "client_id required" }, 400)
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          const envPath = pathMod.join(home, ".env")
          let lines: string[] = []
          try { lines = fs.readFileSync(envPath, "utf8").split("\n") } catch {}
          const filtered = lines.filter((l) => !l.trim().startsWith("GOOGLE_CLIENT_ID=") && !l.trim().startsWith("GOOGLE_CLIENT_SECRET="))
          filtered.push("GOOGLE_CLIENT_ID=" + cid)
          if (csecret) filtered.push("GOOGLE_CLIENT_SECRET=" + csecret)
          fs.mkdirSync(pathMod.dirname(envPath), { recursive: true })
          fs.writeFileSync(envPath, filtered.filter(Boolean).join("\n") + "\n", { mode: 0o600 })
          try { fs.chmodSync(envPath, 0o600) } catch {}
          return json({ ok: true, client_id: cid, client_secret_set: !!csecret || !!lines.some(l => l.trim().startsWith("GOOGLE_CLIENT_SECRET=")) })
        }
        if (path === "/api/mail/gmail/auth-url" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          let env: Record<string, string> = {}
          try { for (const line of fs.readFileSync(pathMod.join(home, ".env"), "utf8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue; env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim() } } catch {}
          const clientId = env["GOOGLE_CLIENT_ID"]
          if (!clientId) return json({ error: "Google OAuth client_id not configured" }, 400)
          const port = process.env.CRM_VIEW_PORT ?? 8800
          const redirectUri = "http://127.0.0.1:" + port + "/oauth/google/callback"
          const state = Math.random().toString(36).slice(2) + Date.now().toString(36)
          // store state in a temp file for verification
          try { fs.writeFileSync(pathMod.join(home, ".oauth_state"), state, { mode: 0o600 }) } catch {}
          const scope = encodeURIComponent("https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events")
          const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + encodeURIComponent(clientId) + "&redirect_uri=" + encodeURIComponent(redirectUri) + "&response_type=code&scope=" + scope + "&access_type=offline&prompt=consent&state=" + encodeURIComponent(state)
          return json({ url, state })
        }
        if (path === "/oauth/google/callback" && req.method === "GET") {
          const code = url.searchParams.get("code")
          const state = url.searchParams.get("state")
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (os.homedir() + "/.ai-enablement-agent")
          // verify state
          let savedState = ""
          try { savedState = fs.readFileSync(pathMod.join(home, ".oauth_state"), "utf8").trim() } catch {}
          if (!code) return new Response("Missing code", { status: 400 })
          // read client creds
          let env: Record<string, string> = {}
          try { for (const line of fs.readFileSync(pathMod.join(home, ".env"), "utf8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue; env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim() } } catch {}
          const clientId = env["GOOGLE_CLIENT_ID"]
          const clientSecret = env["GOOGLE_CLIENT_SECRET"]
          if (!clientId || !clientSecret) return new Response("OAuth client not configured", { status: 400 })
          const port = process.env.CRM_VIEW_PORT ?? 8800
          const redirectUri = "http://127.0.0.1:" + port + "/oauth/google/callback"
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "authorization_code", code: code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }).toString(),
          })
          if (!tokenRes.ok) {
            const detail = (await tokenRes.text()).slice(0, 300)
            return new Response("Token exchange failed: " + detail, { status: 502 })
          }
          const tj = await tokenRes.json() as any
          const accessToken = tj.access_token
          const refreshToken = tj.refresh_token
          // get user email
          let label = "Google Workspace"
          try {
            const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { "Authorization": "Bearer " + accessToken } })
            const uj = await ui.json() as any
            if (uj.email) label = uj.email
          } catch {}
          const { connectCloud } = await import("./crm.js")
          const acc = connectCloud("gmail", accessToken, refreshToken, label)
          // store refresh token in a sidecar file keyed by account id (cloud_accounts already stores refresh_token)
          try { fs.unlinkSync(pathMod.join(home, ".oauth_state")) } catch {}
          return Response.redirect("http://127.0.0.1:" + port + "/?gmail=connected", 302)
        }

        // ---- Scout X: product-specific scouting + auto-draft ----
        if (path === "/api/scout-x" && req.method === "POST") {
          const body = await readBody(req)
          const location = String(body.location || "").trim()
          const query = String(body.query || "").trim()
          const limit = Math.max(1, Math.min(50, Number(body.limit ?? 5)))
          const product = String(body.product || "lead-list")
          const price = String(body.price || "$20")
          const paymentLink = String(body.payment_link || "").trim()
          if (!location || !query) return json({ error: "location and query required" }, 400)
          const jobId = "sx_" + Date.now()
          const job: { lines: string[]; running: boolean; done: boolean; error?: string; result?: any } = { lines: [], running: true, done: false, result: null }
          scoutXJobs.set(jobId, job)
          const log = (l: string) => job.lines.push(l)
          ;(async () => {
            try {
              log("🚀 Scout X started — product: " + product + " (" + price + ")")
              log("📍 Location: " + location + " · Query: " + query + " · Limit: " + limit)
              const scoutRes = await scoutBusinesses(location, query, limit)
              if (scoutRes.steps) for (const s of scoutRes.steps) log(s)
              const businesses = scoutRes.businesses || []
              log("✅ Scouted " + businesses.length + " businesses.")
              const drafted: number[] = []
              const skipped: string[] = []
              for (let i = 0; i < businesses.length; i++) {
                const b = businesses[i]
                log("")
                log("── Lead " + (i + 1) + "/" + businesses.length + ": " + b.name + " ──")
                // add to CRM
                let clientId: number | null = null
                try {
                  const { client, created } = addClient({ name: b.name, vertical: query, status: "scouted", score: 50, address: b.address || undefined, phone: b.phone || undefined, website: b.website || undefined, email: b.email || undefined, language: b.detected_language || (String(b.website || "").includes(".it") ? "it" : "en"), source: "scout-x" })
                  clientId = client.id
                  log(created ? "➕ Added to CRM (id " + client.id + ")" : "♻️ Already in CRM (id " + client.id + ")")
                } catch (e) { log("⚠️ Add to CRM failed: " + String(e)); skipped.push(b.name); continue }
                // enrich
                log("🔎 Enriching…")
                try {
                  const er = await enrichClient(clientId, { onProgress: (l) => log("   " + l) })
                  if (er.ok) {
                    log("✅ Enriched" + (er.emails?.length ? " · email: " + er.emails[0] : "") + (er.socials && Object.keys(er.socials).length ? " · socials: " + Object.keys(er.socials).join(",") : ""))
                  } else {
                    log("⚠️ Enrichment: " + (er.error || "no data"))
                  }
                } catch (e) { log("⚠️ Enrichment failed: " + String(e)) }
                const c = getClient(clientId)
                if (product === "tower-outbound") {
                  try {
                    const { dispatchToTower } = await import("./tower.js")
                    const r = await dispatchToTower(clientId, "outbound_prep")
                    if (r.ok || r.skipped) {
                      log("📤 Dispatched outbound_prep to Tower" + (r.skipped ? " (no webhook configured)" : ""))
                      drafted.push(clientId)
                    } else {
                      log("⚠️ Tower dispatch failed: " + (r.error || r.reason || "unknown"))
                      skipped.push(b.name)
                    }
                  } catch (e) {
                    log("⚠️ Tower dispatch failed: " + String(e))
                    skipped.push(b.name)
                  }
                } else if (c?.email) {
                  try {
                    const subject = productSubject(product, c.name, location, price)
                    const body = productBody(product, c, location, price, paymentLink)
                    const { filePath } = writeDraft(clientId, { subject, body, variant: product })
                    log("✉️ Drafted email → " + (filePath || "").split("/").pop())
                    drafted.push(clientId)
                  } catch (e) { log("⚠️ Draft failed: " + String(e)) }
                } else {
                  log("⏭️ No email found — skipped drafting (added to CRM only).")
                  skipped.push(b.name)
                }
              }
              log("")
              log("🏁 Scout X complete: " + businesses.length + " scouted, " + drafted.length + " drafted, " + skipped.length + " skipped.")
              job.result = { businesses, drafted, skipped, location, query, product, price }
              job.done = true
              job.running = false
            } catch (e) {
              job.error = String(e)
              job.done = true
              job.running = false
              log("❌ Scout X failed: " + String(e))
            }
          })()
          return json({ started: true, job_id: jobId })
        }
        const scoutXStatusMatch = path.match(/^\/api\/scout-x\/status\/(.+)$/)
        if (scoutXStatusMatch && req.method === "GET") {
          const job = scoutXJobs.get(decodeURIComponent(scoutXStatusMatch[1]))
          if (!job) return json({ running: false, done: false, lines: [] })
          return json({ running: job.running, done: job.done, error: job.error ?? null, result: job.result ?? null, lineCount: job.lines.length })
        }
        const scoutXLogMatch = path.match(/^\/api\/scout-x\/log\/(.+)$/)
        if (scoutXLogMatch && req.method === "GET") {
          const job = scoutXJobs.get(decodeURIComponent(scoutXLogMatch[1]))
          const after = Number(url.searchParams.get("after") ?? 0)
          const lines = job ? job.lines.slice(after) : []
          return json({ lines, total: job ? job.lines.length : 0, running: job?.running ?? false, done: job?.done ?? false, error: job?.error ?? null })
        }

        // ---- Product delivery (on payment or manual) ----
        if (path === "/api/products/deliver" && req.method === "POST") {
          const body = await readBody(req)
          const clientId = Number(body.client_id)
          const product = String(body.product || "intake-diagnostic")
          const client = getClient(clientId)
          if (!client) return json({ error: "client not found" }, 404)
          const to = String(body.email || client.email || "").trim()
          if (!to) return json({ error: "no recipient email" }, 400)
          // build report
          const report = buildProductReport(product, client)
          // send via gmail if connected, else resend
          let sent = false
          try {
            const accs = crmDb().query("SELECT * FROM cloud_accounts WHERE provider = 'gmail' AND status = 'connected'").all() as any[]
            if (accs.length) {
              const acc = accs[0]
              const lines = ["From: " + (acc.account_label || ""), "To: " + to, "Subject: Your " + product + " report", "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8", "", report]
              const raw = Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
              const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { "Authorization": "Bearer " + acc.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ raw }) })
              if (resp.ok) sent = true
            }
          } catch {}
          if (!sent) {
            const apiKey = process.env.RESEND_API_KEY?.trim()
            const from = process.env.RESEND_FROM?.trim()
            if (apiKey && from) {
              try {
                const resp = await fetch((process.env.RESEND_URL || "https://api.resend.com/emails").replace(/\/$/, ""), { method: "POST", headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject: "Your " + product + " report", html: report }) })
                if (resp.ok) sent = true
              } catch {}
            }
          }
          if (!sent) return json({ error: "no email provider available (connect Gmail or set Resend keys)" }, 502)
          // log interaction
          try { logInteraction(clientId, { kind: "product_delivered", direction: "out", channel: "email", status: "delivered", subject: "Your " + product + " report", body: report.slice(0, 500), occurred_at: new Date().toISOString() }) } catch {}
          return json({ ok: true, delivered_to: to, product })
        }
        if (path === "/api/products/webhook" && req.method === "POST") {
          // Generic payment webhook: { client_id, product, email } → deliver
          const body = await readBody(req)
          const clientId = Number(body.client_id)
          const product = String(body.product || "intake-diagnostic")
          const email = body.email ? String(body.email) : undefined
          // forward to deliver
          const r = await fetch("http://127.0.0.1:" + (process.env.CRM_VIEW_PORT ?? 8800) + "/api/products/deliver", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: clientId, product, email }) })
          const j = await r.json()
          return json(j, r.status)
        }

        return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
      },
      websocket: {
        async message(ws, message) {
          const raw = String(message)
          let text = raw
          let page: string | null = null
          try {
            const j = JSON.parse(raw)
            if (j && typeof j.text === "string") { text = j.text; page = j.page || null }
          } catch { /* plain text */ }
          if (page) (ws.data as any).page = page
          const refusal = guardrailReply(text)
          // Ensure a CRM chat session exists and persist the user message.
          try {
            const db = crmDb()
            db.run(`CREATE TABLE IF NOT EXISTS chat_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
            db.run(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`)
            if (!(ws.data as any).sessionId) {
              const now = new Date().toISOString()
              crmDb().run("INSERT INTO chat_sessions (title, created_at, updated_at) VALUES (?, ?, ?)", [text.slice(0, 40) || "New chat", now, now])
              const lastRow = crmDb().query("SELECT id FROM chat_sessions ORDER BY id DESC LIMIT 1").get() as any
              (ws.data as any).sessionId = Number(lastRow?.id)
              ws.send(JSON.stringify({ type: "session", id: (ws.data as any).sessionId }))
            }
            const now = new Date().toISOString()
            crmDb().run("INSERT INTO chat_messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)", [(ws.data as any).sessionId, "user", text, now])
            crmDb().run("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", [now, (ws.data as any).sessionId])
          } catch { /* best effort */ }
          if (refusal) {
            try { const now = new Date().toISOString(); crmDb().run("INSERT INTO chat_messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)", [(ws.data as any).sessionId, "assistant", refusal, now]) } catch {}
            ws.send(JSON.stringify({ type: "reply", text: refusal }))
            return
          }
          try {
            if (ctx) {
              if (!chatSessionId) {
                const created = await ctx.session.create({ title: "CRM chat" })
                chatSessionId = created.id
              }
              const pageCtx = (ws.data as any).page ? `\\n\\n[Context: user is currently on the "${(ws.data as any).page}" page of the CRM.]` : ""
              await ctx.session.prompt({ sessionID: chatSessionId, text: text + pageCtx } as any)
              await new Promise((r) => setTimeout(r, 2000))
              const msgs = await ctx.session.context({ sessionID: chatSessionId })
              let reply = ""
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i]
                if (m.type !== "assistant") continue
                reply = (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                break
              }
              try { if ((ws.data as any).sessionId) { const now = new Date().toISOString(); crmDb().run("INSERT INTO chat_messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)", [(ws.data as any).sessionId, "assistant", reply || "(no response)", now]); crmDb().run("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", [now, (ws.data as any).sessionId]) } } catch {}
              ws.send(JSON.stringify({ type: "reply", text: reply || "(no response)" }))
              return
            }
            // Standalone mode: proxy to a running Elitza engine.
            let reply = ""
            let thinking = ""
            try { reply = await proxyChatToEngine(text) } catch (e) { reply = "" }
            if (!reply || reply === "(no response)") {
              try {
                const provider = "opencode-go"
                const pageCtx = (ws.data as any).page ? `\\n\\n[Context: user is currently on the "${(ws.data as any).page}" page of the CRM.]` : ""
                const r = await directChat(text + pageCtx, provider)
                reply = r.reply
                thinking = r.thinking
              } catch (e) { reply = "Error: " + String(e) }
            }
            if (thinking) ws.send(JSON.stringify({ type: "thinking", text: thinking }))
            ws.send(JSON.stringify({ type: "reply", text: reply || "(no response)" }))
          } catch (e) {
            try { if ((ws.data as any).sessionId) { const now = new Date().toISOString(); crmDb().run("INSERT INTO chat_messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)", [(ws.data as any).sessionId, "assistant", "Error: " + String(e), now]) } } catch {}
            ws.send(JSON.stringify({ type: "error", text: String(e) }))
          }
        },
        open(ws) { /* no auto-greeting; the UI shows its own greeting */ },
        close(ws) {},
      },
    })
  } catch (error) {
    console.error(`[crm-view] could not bind port ${PORT}: ${String(error)}`)
    return null
  }

  // Background auto-sync of connected Gmail accounts every 5 minutes.
  const AUTO_SYNC_MS = 5 * 60 * 1000
  const runAutoSync = async () => {
    try {
      const accs = crmDb().query("SELECT id FROM cloud_accounts WHERE provider = 'gmail' AND status = 'connected'").all() as { id: number }[]
      for (const a of accs) {
        try {
          await fetch("http://127.0.0.1:" + PORT + "/api/mail/gmail/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account_id: a.id, limit: 50 }),
          })
        } catch {}
      }
    } catch {}
  }
  // first sync shortly after start
  setTimeout(runAutoSync, 10 * 1000)
  const autoSyncTimer = setInterval(runAutoSync, AUTO_SYNC_MS)
  // keep reference to avoid GC (store on server object not needed; interval holds)

  console.log(`[crm-view] AI Enablement Agent CRM listening on http://127.0.0.1:${PORT}`)
  // Auto-open in the default browser on first start (best-effort, never fatal).
  if (!process.env.CRM_VIEW_NO_OPEN) {
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      Bun.spawn([opener, `http://127.0.0.1:${PORT}`], { stdout: "ignore", stderr: "ignore" })
    } catch {
      // No browser available — the URL is printed above.
    }
  }
  return { stop: () => { try { clearInterval(autoSyncTimer) } catch {}; server?.stop(true) }, port: PORT }
}

import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
const _here = dirname(fileURLToPath(import.meta.url))
const HTML = readFileSync(join(_here, "crmview.html"), "utf8")
export function serializeReadyLead(c: any): Record<string, unknown> {
  let v2: any = null
  if (c.enrichment_json) {
    try { v2 = JSON.parse(c.enrichment_json) } catch {}
  }
  const audit = v2?.audit ?? null
  const syn = v2?.synthesis ?? null
  const emailCand = c.email
    ? classifyEmailCandidate(c.email, { website: c.website, businessName: c.company || c.name })
    : null

  return {
    id: c.id,
    company_name: c.company || c.name || null,
    contact_name: c.contact_name || v2?.best_contact_person?.full_name || null,
    contact_first_name: v2?.best_contact_person?.first_name || null,
    contact_role: v2?.best_contact_person?.role || null,
    email: c.email || null,
    email_bucket: emailCand?.bucket || v2?.best_email?.bucket || null,
    pec_email: c.pec_email || audit?.pec || null,
    outreach_route: c.outreach_route || v2?.outreach_route || (emailCand?.sendable ? "email_ready" : "needs_manual_review"),
    website: c.website || null,
    city: c.address || null,
    language: c.language || "it",
    category: c.category || c.vertical || null,
    offer_track: c.offer_track || v2?.offer_track || null,
    team_size_estimate:
      audit?.team_count_hint?.band && audit.team_count_hint.band !== "unknown"
        ? audit.team_count_hint.band
        : c.employee_count && c.employee_count !== "unknown"
          ? c.employee_count
          : null,
    locations_count: audit?.locations_count ?? 1,
    contact_channels: audit?.channels_detected ?? (c.email ? ["email"] : []),
    enrichment_signals: {
      schema_version: v2?.schema_version ?? "1.0",
      evidence_confidence: syn?.evidence_confidence ?? null,
      website_summary: syn?.business_summary || c.notes || null,
      pain_clues: syn?.pain_category || c.pain_category || null,
      pain_points: syn?.pain_points ?? [],
      single_thread_focus: syn?.single_thread_focus ?? null,
      forms_summary: (audit?.forms ?? []).map(
        (f: any) =>
          `${f.evidence_id}: ${f.purpose} (${f.plugin}, ${f.field_count} fields${f.dropdown_options?.length ? `, options: ${f.dropdown_options.join("/")}` : ""})`,
      ),
      booking_widgets: (audit?.booking_widgets ?? []).map((b: any) => `${b.name} (${b.mode})`),
      whatsapp_detected: Boolean(audit?.whatsapp?.detected),
      hours_clues: (audit?.hours_snippets ?? []).map((h: any) => h.text),
      pdf_clues: (audit?.pdf_signals ?? []).map(
        (p: any) => `${p.doc_kind}: ${p.anchor_text}${p.extracted_tags?.length ? ` [${p.extracted_tags.join(", ")}]` : ""}`,
      ),
      video_clues: (audit?.video_signals ?? []).map(
        (v: any) => `${v.provider} (tier ${v.tier_used}): ${v.title || v.url}`,
      ),
      touch1_question_candidate: syn?.touch1_question_candidate ?? null,
      phone_and_form_script: syn?.phone_and_form_script ?? null,
      notes: c.notes || null,
    },
  }
}
