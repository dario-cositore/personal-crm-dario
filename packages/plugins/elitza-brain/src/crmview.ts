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

const DEFAULT_STAGES = [
  { id: "scouted", label: "Scouted", color: "#62666d", statusColor: "muted" },
  { id: "contacted", label: "Contacted", color: "#4ea7fc", statusColor: "info" },
  { id: "followup_1", label: "Follow-up 1", color: "#4ea7fc", statusColor: "info" },
  { id: "followup_2", label: "Follow-up 2", color: "#4ea7fc", statusColor: "info" },
  { id: "followup_3", label: "Follow-up 3", color: "#4ea7fc", statusColor: "info" },
  { id: "yes", label: "Won", color: "#27a644", statusColor: "ok" },
  { id: "no", label: "Lost", color: "#eb5757", statusColor: "err" },
  { id: "stale", label: "Stale", color: "#f2c94c", statusColor: "warn" },
  { id: "diagnose", label: "Diagnose", color: "#7170ff", statusColor: "accent" },
  { id: "proposal", label: "Proposal", color: "#7170ff", statusColor: "accent" },
  { id: "workbook", label: "Workbook", color: "#7170ff", statusColor: "accent" },
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
    "instruction", "system prompt", "your prompt", "prompting", "guardrail", "contract",
    "background", "persona", "soul", "internal", "how are you built", "how were you made",
    "your code", "source code", "training", "what are you", "who are you", "tell me about yourself",
    "reveal", "show me your", "share your",
  ]
  if (sensitive.some((k) => t.includes(k))) {
    return "I can't share that. I'm Elitza, an AI Enablement operator — I handle scouting, CRM, outreach, enrichment, and delivery. How can I help with your clients?"
  }
  const cap = [
    "what can you do", "what do you do", "your capabilities", "your tools", "what tools",
    "list your tools", "what are your tools", "your api", "what api", "what features",
    "what functions", "what commands", "help me", "how do you work", "what do you know",
  ]
  if (cap.some((k) => t.includes(k))) {
    return "I'm Elitza, an AI Enablement operator. I help you scout local clients, qualify them in a CRM, enrich leads, run outreach cadence, and deliver implementation sprints. I don't share my internal tooling or implementation details. What would you like to do with your clients?"
  }
  return null
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


async function directChat(text: string, provider?: "mimo" | "opencode-go", modelOverride?: string, variantOverride?: string): Promise<{ thinking: string; reply: string }> {
  const refusal = guardrailReply(text)
  if (refusal) return { thinking: "", reply: refusal }
  // Read provider/model from soul if not explicitly passed.
  if (!provider) {
    try {
      const { soulGet } = await import("./soul.js")
      provider = (soulGet("chat_provider", process.env.ELITZA_CHAT_PROVIDER || "opencode-go")) as "mimo" | "opencode-go"
    } catch {
      provider = "opencode-go"
    }
  }
  // Standalone fallback: call the configured provider directly with SOUL.md as system prompt.
  let apiKey = ""
  let baseUrl = ""
  let model = "mimo-v2.6-flash"
  let variant = ""
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
    model = modelOverride || "mimo-v2.6-flash"
    try {
      const { soulGet } = await import("./soul.js")
      const saved = soulGet("chat_model", "")
      if (saved && !modelOverride) model = saved
      const savedVariant = soulGet("chat_variant", "")
      if (savedVariant && !variantOverride) variant = savedVariant
      if (variantOverride) variant = variantOverride
    } catch {}
  } else {
    // Resolve the OpenCode Go plan credential from Elitza's own store (never from another OpenCode).
    if (!apiKey) {
      try {
        const Database = (await import("bun:sqlite")).default
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.elitza/home/data/elitza.db")
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
  }
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
    const body: any = { model: model, messages, stream: false, max_tokens: 2000 }
    if (variant) body.reasoning_effort = variant
    if (!isLast) body.tools = tools
    const fetchHeaders: Record<string, string> = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey }
    if (provider === "opencode-go") {
      // Read org ID from the opencode console credential.
      try {
        const Database = (await import("bun:sqlite")).default
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.elitza/home/data/elitza.db")
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
            provider: soulGet("chat_provider", process.env.ELITZA_CHAT_PROVIDER || "opencode-go"),
            model: soulGet("chat_model", "beam-free"),
            variant: soulGet("chat_variant", ""),
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
        if (path === "/api/settings/provider" && req.method === "POST") {
          const body = await readBody(req)
          const { soulSet } = await import("./soul.js")
          const provider = String(body.provider ?? "opencode-go")
          soulSet("chat_provider", provider)
          // Reset model to default for the new provider.
          if (provider === "mimo") soulSet("chat_model", "mimo-v2.6-flash")
          else soulSet("chat_model", "beam-free")
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
          const provider = url.searchParams.get("provider") || "opencode-go"
          if (provider === "mimo") {
            return json({ provider, models: ["mimo-v2.6-flash"] })
          }
          // Pull ALL models available for the OpenCode Go plan from the console.
          let models: string[] = []
          try {
            const Database = (await import("bun:sqlite")).default
            const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.elitza/home/data/elitza.db")
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
            const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.elitza/home/data/elitza.db")
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
            const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.elitza/home/data/elitza.db")
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
        // --- Skills management (Elitza skills = ~/.elitza/skills/<name>/SKILL.md) ---
        const skillsRoot = (process.env.ELITZA_HOME || ((process.env.HOME || "") + "/.elitza")) + "/skills"
        const skillsManifestPath = (process.env.ELITZA_HOME || ((process.env.HOME || "") + "/.elitza")) + "/skills-manifest.json"
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
        // Pipeline stages config
        if (path === "/api/pipeline/stages" && req.method === "GET") {
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = process.env.ELITZA_HOME || (os.homedir() + "/.elitza")
          const filePath = pathMod.join(home, "pipeline-stages.json")
          let stages: any[]
          try {
            stages = JSON.parse(fs.readFileSync(filePath, "utf8"))
            if (!Array.isArray(stages) || stages.length === 0) stages = DEFAULT_STAGES
          } catch {
            stages = DEFAULT_STAGES
          }
          // Migrate orphaned clients: move any client whose status is not in the configured stages to the first stage.
          const validIds = new Set(stages.map((s: any) => s.id))
          const firstStage = stages[0]?.id
          if (firstStage) {
            try {
              const rows = crmDb().query("SELECT id, status FROM clients").all() as any[]
              let migrated = 0
              for (const row of rows) {
                if (!validIds.has(row.status)) {
                  crmDb().run("UPDATE clients SET status = ?, updated_at = ? WHERE id = ?", [firstStage, new Date().toISOString(), row.id])
                  migrated++
                }
              }
            } catch { /* best effort */ }
          }
          return json({ stages })
        }
        if (path === "/api/pipeline/stages" && req.method === "POST") {
          const body = await readBody(req)
          let stages = Array.isArray(body.stages) ? body.stages : []
          if (stages.length === 0) stages = DEFAULT_STAGES
          const fs = await import("node:fs")
          const pathMod = await import("node:path")
          const os = await import("node:os")
          const home = process.env.ELITZA_HOME || (os.homedir() + "/.elitza")
          const filePath = pathMod.join(home, "pipeline-stages.json")
          fs.writeFileSync(filePath, JSON.stringify(stages, null, 2), { mode: 0o600 })
          // Migrate orphaned clients to the first stage.
          const validIds = new Set(stages.map((s: any) => s.id))
          const firstStage = stages[0]?.id
          if (firstStage) {
            try {
              const rows = crmDb().query("SELECT id, status FROM clients").all() as any[]
              for (const row of rows) {
                if (!validIds.has(row.status)) {
                  crmDb().run("UPDATE clients SET status = ?, updated_at = ? WHERE id = ?", [firstStage, new Date().toISOString(), row.id])
                }
              }
            } catch { /* best effort */ }
          }
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
          for (const k of ["name","vertical","status","score","address","phone","website","email","linkedin","twitter","facebook","instagram","notes","deal_value","next_action","next_action_at","last_contact","source","language"]) {
            if (k in body) patch[k] = body[k]
          }
          const client = updateClient(id, patch)
          return json({ client })
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
                const provider = (process.env.ELITZA_CHAT_PROVIDER || "opencode-go") as "mimo" | "opencode-go"
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