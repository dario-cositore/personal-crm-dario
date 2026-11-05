/**
 * Elitza CRM "house" — a zero-build, single-page web dashboard over the CRM.
 *
 * Exposes `startCrmView()` which binds an HTTP server (default port 8787,
 * override with CRM_VIEW_PORT) serving a JSON API + an embedded HTML
 * dashboard. Reuses the exact same brain modules as the TUI, so there is no
 * second source of truth. Returns a cleanup function that stops the server.
 *
 * The plugin calls this from its setup hook so the house comes up whenever
 * the engine (elitza serve) starts and goes down when it stops.
 */

import { addClient, findClients, countClients, getClient, updateClient, listInteractions, listAssets, listCompanies, crmDb, saveScoutRun, listScoutRuns, getScoutRun, deleteScoutRun, listSegments, getSegment, saveSegment, updateSegment, deleteSegment, countSegmentMembers, listSegmentMembers } from "./crm.js"
import { makeBrainTools } from "./tools.js"
import { approveDrafts, sendApproved, listPipeline } from "./outreach.js"
import { advance, recordPayment, scheduleCall, productionState } from "./production.js"
import { scoutBusinesses } from "./scouting.js"
import { enrichClient } from "./enrichment.js"
import { listWorksheets, recommendWorksheets, pullWorksheet } from "./worksheets.js"

// Load ~/.elitza/.env (mode 600) into process.env, like the elitza launcher does.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
try {
  const envPath = join(homedir(), ".elitza", ".env")
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

const STATUSES = ["scouted","contacted","followup_1","followup_2","followup_3","yes","no","stale","diagnose","proposal","workbook","scheduled","payment","done"]

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}

async function readBody(req: Request): Promise<any> {
  try { return await req.json() } catch { return {} }
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


async function directChat(text: string, provider: "mimo" | "opencode-go" = "opencode-go"): Promise<{ thinking: string; reply: string }> {
  // Standalone fallback: call the configured provider directly with SOUL.md as system prompt.
  let apiKey = ""
  let baseUrl = ""
  let model = "mimo-v2.6-flash"
  let soul = ""
  let home = process.env.ELITZA_HOME || (process.env.HOME || "") + "/.elitza"
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const os = await import("node:os")
    home = process.env.ELITZA_HOME || (process.env.HOME || os.homedir()) + "/.elitza"
    const envPath = path.join(home, ".env")
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq < 0) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (provider === "mimo" && k === "XIAOMI_API_KEY" && !apiKey) apiKey = v
      if (provider === "opencode-go" && k === "OPENCODE_API_KEY" && !apiKey) apiKey = v
    }
    const soulPath = path.join(home, "SOUL.md")
    try { soul = fs.readFileSync(soulPath, "utf8").slice(0, 800) } catch {}
  } catch { /* ignore */ }
  if (provider === "mimo") {
    apiKey = apiKey || process.env.XIAOMI_API_KEY || ""
    baseUrl = "https://api.xiaomimimo.com/v1"
    if (apiKey.toLowerCase().startsWith("tp-")) baseUrl = "https://token-plan-ams.xiaomimimo.com/v1"
    model = "mimo-v2.6-flash"
  } else {
    // Read the opencode console credential from the opencode.db if no API key is set.
    if (!apiKey) {
      try {
        const Database = (await import("bun:sqlite")).default
        const dbPath = (process.env.HOME || "") + "/.local/share/opencode/opencode.db"
        const db = new Database(dbPath, { readonly: true })
        const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
        if (row?.value) {
          const cred = JSON.parse(row.value)
          if (cred.access) apiKey = cred.access
        }
        db.close()
      } catch { /* ignore */ }
    }
    apiKey = apiKey || process.env.OPENCODE_API_KEY || ""
    baseUrl = "https://opencode.ai/inference/go/openai/v1"
    model = "beam-free"
  }
  if (!apiKey) return { thinking: "", reply: "No API key configured for " + provider + ". Run `elitza` setup first." }
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
  if (soul) messages.push({ role: "system", content: soul + "\n\nYou have access to CRM tools. Use them to act on the user's requests. Confirm actions taken. For greetings or small talk, reply directly without calling tools." })
  messages.push({ role: "user", content: text })

  let thinking = ""
  // tool-calling loop (omit tools on final pass so the model must answer in text)
  for (let iter = 0; iter < 4; iter++) {
    const isLast = iter === 3
    const body: any = { model: model, messages, stream: false }
    if (!isLast) body.tools = tools
    const fetchHeaders: Record<string, string> = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey }
    if (provider === "opencode-go") {
      // Read org ID from the opencode console credential.
      try {
        const Database = (await import("bun:sqlite")).default
        const dbPath = (process.env.HOME || "") + "/.local/share/opencode/opencode.db"
        const db = new Database(dbPath, { readonly: true })
        const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%'").get() as any
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
      return { thinking, reply: msg.content || "(no response)" }
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

export function startCrmView(ctx?: any): { stop: () => void; port: number } | null {
  const PORT = Number(process.env.CRM_VIEW_PORT ?? 8787)
  let chatSessionId: string | null = null
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    server = Bun.serve({
      port: PORT,
      async fetch(req, server) {
        const url = new URL(req.url)
        const path = url.pathname

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" } })
        }

        // WebSocket upgrade for Ask Elitza chat
        if (path === "/ws/chat") {
          const upgraded = server.upgrade(req, { data: {} })
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
              `Setup with ${answers.human ?? "my person"}: my name is ${answers.name ?? "Elitza"}, I am ${answers.role ?? "a companion"}, I talk ${answers.voice ?? "directly"}, my initiative is ${answers.initiative ?? "balanced"}. Hard rules: ${answers.never ?? "none"}. I ask first about: ${answers.ask_first ?? "nothing"}.`,
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
            provider: soulGet("provider", "mimo"),
            mimo_key: soulGet("mimo_key", "not set"),
            maton_key: soulGet("maton_key", "not set"),
            user_name: soulGet("user_name", ""),
            role: soulGet("role", ""),
            voice: soulGet("style", ""),
            active_vertical: getActiveVertical(),
            verticals: listVerticals(),
            permission_gates: gates.permission ?? {},
            heartbeat_last_tick: soulGet("heartbeat_last_tick", ""),
            heartbeat_last_error: heartbeatError,
            cost_7d: costSummary(7),
            crm_port: Number(process.env.CRM_VIEW_PORT ?? 8787),
            elitza_home: process.env.ELITZA_HOME || (process.env.HOME + "/.elitza"),
          })
        }
        if (path === "/api/settings/vertical" && req.method === "POST") {
          const body = await readBody(req)
          const { setActiveVertical } = await import("./verticals.js")
          const ok = setActiveVertical(String(body.vertical ?? ""))
          return json({ ok })
        }
        if (path === "/api/settings/backup" && req.method === "POST") {
          const { execSync } = await import("node:child_process")
          const os = await import("node:os")
          const pathm = await import("node:path")
          const out = pathm.join(os.homedir(), "elitza-backup-" + new Date().toISOString().slice(0, 10) + ".tar.gz")
          try {
            execSync("tar -czf " + out + " -C " + (process.env.HOME || os.homedir()) + " .elitza", { stdio: "pipe" })
            return json({ ok: true, path: out })
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
            for (const line of txt.split("\\n")) {
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
          const allowed = new Set(["XIAOMI_API_KEY", "GOOGLE_MAPS_API_KEY", "RESEND_API_KEY", "RESEND_FROM"])
          if (!allowed.has(name)) return json({ error: "unknown secret" }, 400)
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = process.env.ELITZA_HOME || (os.homedir() + "/.elitza")
          const envPath = pathMod.join(home, ".env")
          // read existing
          let lines: string[] = []
          try { lines = fs.readFileSync(envPath, "utf8").split("\\n") } catch {}
          const filtered = lines.filter((l) => !l.trim().startsWith(name + "="))
          filtered.push(name + "=" + value)
          fs.mkdirSync(pathMod.dirname(envPath), { recursive: true })
          fs.writeFileSync(envPath, filtered.filter(Boolean).join("\\n") + "\\n", { mode: 0o600 })
          try { fs.chmodSync(envPath, 0o600) } catch {}
          const { soulSet } = await import("./soul.js")
          soulSet(name.toLowerCase().replace(/_/g, "_"), "set")
          return json({ ok: true, set: true })
        }
        if (path === "/api/settings/secrets-status" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = process.env.ELITZA_HOME || (os.homedir() + "/.elitza")
          const envPath = pathMod.join(home, ".env")
          let env: Record<string, string> = {}
          try {
            for (const line of fs.readFileSync(envPath, "utf8").split("\\n")) {
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
            for (const line of fs.readFileSync(p, "utf8").split("\\n")) {
              const t = line.trim()
              if (t.startsWith("MATON_API_KEY=") && t.slice("MATON_API_KEY=".length).trim()) { matonSet = true }
            }
          } catch {}
          return json({
            xiaomi: !!env["XIAOMI_API_KEY"],
            google_maps: !!env["GOOGLE_MAPS_API_KEY"],
            resend: !!env["RESEND_API_KEY"],
            resend_from: !!env["RESEND_FROM"],
            maton: matonSet,
          })
        }
        if (path === "/api/clients" && req.method === "GET") {
          const status = url.searchParams.get("status") ?? undefined
          const query = url.searchParams.get("q") ?? undefined
          const sort = url.searchParams.get("sort") ?? undefined
          const dir = (url.searchParams.get("dir") === "asc" ? "asc" : "desc") as "asc" | "desc"
          const pipeline = url.searchParams.get("pipeline") === "1"
          const perPage = Math.max(1, Math.min(200, Number(url.searchParams.get("per_page") ?? url.searchParams.get("limit") ?? 50)))
          const page = Math.max(1, Number(url.searchParams.get("page") ?? 1))
          const offset = (page - 1) * perPage
          const clients = findClients({ status, query, sort, dir, pipeline, limit: perPage, offset })
          const total = countClients({ status, query, pipeline })
          return json({ clients, total, page, per_page: perPage, sort, dir })
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
        if (path === "/api/clients" && req.method === "POST") {
          const body = await readBody(req)
          const { client, created } = addClient({
            name: String(body.name ?? ""),
            vertical: body.vertical, status: body.status, score: body.score,
            address: body.address, phone: body.phone, website: body.website, email: body.email,
            linkedin: body.linkedin, twitter: body.twitter, facebook: body.facebook, instagram: body.instagram,
            notes: body.notes, deal_value: body.deal_value, source: body.source,
            next_action: body.next_action, next_action_at: body.next_action_at,
          })
          return json({ client, created })
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
        if (path === "/api/clients/update" && req.method === "POST") {
          const body = await readBody(req)
          const id = Number(body.id)
          const patch: any = {}
          for (const k of ["name","vertical","status","score","address","phone","website","email","linkedin","twitter","facebook","instagram","notes","deal_value","next_action","next_action_at","last_contact","source"]) {
            if (k in body) patch[k] = body[k]
          }
          const client = updateClient(id, patch)
          return json({ client })
        }
        if (path === "/api/drafts" && req.method === "GET") {
          const rows = listPipeline({ limit: 200 }).filter((r) => r.draft_path)
          const drafts = rows.map((r) => {
            const c = getClient(r.client_id)
            return { id: r.id, client_id: r.client_id, client_name: c?.name ?? null, subject: r.draft_path, path: r.draft_path, approved: r.approved, stage: r.stage }
          })
          return json({ drafts })
        }
        if (path === "/api/approve" && req.method === "POST") {
          const body = await readBody(req)
          const ids = (body.ids ?? []).map(Number)
          const rows = approveDrafts(ids)
          return json({ approved: rows.length, rows })
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
        if (path === "/api/scout/runs" && req.method === "GET") {
          return json({ runs: listScoutRuns() })
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
          const result = await enrichClient(Number(body.id))
          return json(result)
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
          const allowed = [`${home}/.elitza`, "/tmp", `${home}/.openclaw`]
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
          const provider = String(body.provider ?? process.env.ELITZA_CHAT_PROVIDER ?? "opencode-go") as "mimo" | "opencode-go"
          // Try engine session first
          let reply = ""
          let thinking = ""
          if (ctx) {
            try {
              if (!chatSessionId) {
                const created = await ctx.session.create({ title: "CRM chat" })
                chatSessionId = created.id
              }
              await ctx.session.prompt({ sessionID: chatSessionId, text: { text } } as any)
              await new Promise((r) => setTimeout(r, 2000))
              const msgs = await ctx.session.context({ sessionID: chatSessionId })
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i]
                if (m.type !== "assistant") continue
                reply = (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\\n")
                break
              }
            } catch (e) { reply = "" }
          }
          if (!reply || reply === "(no response)") {
            try {
              const r = await directChat(text, provider)
              reply = r.reply
              thinking = r.thinking
            } catch (e) { reply = "Error: " + String(e) }
          }
          return json({ reply: reply || "(no response)", thinking })
        }
        if (path === "/api/worksheets" && req.method === "GET") {
          return json({ worksheets: listWorksheets() })
        }
        if (path === "/api/worksheets/recommend" && req.method === "GET") {
          const id = Number(url.searchParams.get("id"))
          const client = getClient(id)
          if (!client) return json({ error: "not found" }, 404)
          return json({ client_id: id, recommended: recommendWorksheets(client, Number(url.searchParams.get("limit") ?? 3)) })
        }
        if (path === "/api/worksheets/pull" && req.method === "POST") {
          const body = await readBody(req)
          const result = pullWorksheet(Number(body.id), String(body.worksheet_id ?? ""))
          return json(result)
        }

        return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
      },
      websocket: {
        async message(ws, message) {
          const text = String(message)
          try {
            if (ctx) {
              if (!chatSessionId) {
                const created = await ctx.session.create({ title: "CRM chat" })
                chatSessionId = created.id
              }
              await ctx.session.prompt({ sessionID: chatSessionId, text: { text } } as any)
              await new Promise((r) => setTimeout(r, 2000))
              const msgs = await ctx.session.context({ sessionID: chatSessionId })
              let reply = ""
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i]
                if (m.type !== "assistant") continue
                reply = (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                break
              }
              ws.send(JSON.stringify({ type: "reply", text: reply || "(no response)" }))
              return
            }
            // Standalone mode: proxy to a running Elitza engine.
            let reply = ""
            let thinking = ""
            try { reply = await proxyChatToEngine(text) } catch (e) { reply = "" }
            if (!reply || reply === "(no response)") {
              try {
                const provider = (process.env.ELITZA_CHAT_PROVIDER || "opencode-go") as "mimo" | "opencode-go"
                const r = await directChat(text, provider)
                reply = r.reply
                thinking = r.thinking
              } catch (e) { reply = "Error: " + String(e) }
            }
            if (thinking) ws.send(JSON.stringify({ type: "thinking", text: thinking }))
            ws.send(JSON.stringify({ type: "reply", text: reply || "(no response)" }))
          } catch (e) {
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

  console.log(`[crm-view] Elitza CRM house listening on http://127.0.0.1:${PORT}`)
  // Auto-open in the default browser on first start (best-effort, never fatal).
  if (!process.env.CRM_VIEW_NO_OPEN) {
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      Bun.spawn([opener, `http://127.0.0.1:${PORT}`], { stdout: "ignore", stderr: "ignore" })
    } catch {
      // No browser available — the URL is printed above.
    }
  }
  return { stop: () => server?.stop(true), port: PORT }
}

import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
const _here = dirname(fileURLToPath(import.meta.url))
const HTML = readFileSync(join(_here, "crmview.html"), "utf8")