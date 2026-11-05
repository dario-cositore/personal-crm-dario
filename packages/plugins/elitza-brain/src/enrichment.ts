/**
 * Elitza Brain — client enrichment agent.
 *
 * Given a CRM client, this agent:
 *   1. Fetches the client's own website (homepage + common subpages) and
 *      extracts text, emails, phones and any obvious service keywords.
 *   2. Reads the AI Enablement playbooks (diagnosis, proposal, payment terms)
 *      as the operating manual.
 *   3. Calls MiMo to produce a one-page diagnosis + a fixed-scope proposal
 *      with a recommended price band.
 *   4. Writes the result back into the CRM: updates notes, logs an
 *      interaction, attaches diagnosis.md and proposal.md as assets, and sets
 *      the next action.
 *
 * Nothing is sent to the client. The output is for the operator to read in
 * the CRM before deciding the next move.
 */

import fs from "node:fs"
import path from "node:path"
import { getClient, updateClient, logInteraction, addAsset } from "./crm.js"
import { ELITZA_HOME } from "./db.js"
import { engineConfigPath } from "./configview.js"
import { pullRecommendedWorksheet, recommendWorksheets } from "./worksheets.js"

const PLAYBOOK_DIR = path.join(ELITZA_HOME, "brain", "procedural")
const SUBPAGES = ["/", "/about", "/about-us", "/chi-siamo", "/services", "/servizi", "/contact", "/contatti", "/contact-us"]

function readPlaybook(name: string): string {
  try {
    return fs.readFileSync(path.join(PLAYBOOK_DIR, `${name}.md`), "utf8")
  } catch {
    return ""
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g
const SOCIAL_RE: Record<string, RegExp> = {
  linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/gi,
  twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/gi,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi,
}

async function fetchPage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return ""
    const html = await res.text()
    return stripHtml(html).slice(0, 6000)
  } catch {
    return ""
  }
}

function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? []
  const noise = ["example.", "example@", "sentry.", "wixpress", "yourdomain", "noreply", "no-reply"]
  return [...new Set(matches.map((m) => m.toLowerCase()))].filter((e) => !noise.some((n) => e.includes(n)))
}

function extractPhones(text: string): string[] {
  const matches = text.match(PHONE_RE) ?? []
  return [...new Set(matches.map((m) => m.trim()))].filter((p) => p.replace(/\D/g, "").length >= 7)
}

function extractSocials(text: string): { linkedin?: string; twitter?: string; facebook?: string; instagram?: string } {
  const result: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string } = {}
  for (const [key, re] of Object.entries(SOCIAL_RE)) {
    const m = text.match(re)
    if (m && m[0]) result[key as keyof typeof result] = m[0].replace(/[.,;:]+$/, "")
  }
  return result
}

async function providerConfig(): Promise<{ url: string; key: string; model: string }> {
  const provider = process.env.ELITZA_CHAT_PROVIDER || "opencode-go"
  if (provider === "opencode-go") {
    let key = ""
    // Resolve the OpenCode Go plan credential from Elitza's own store.
    if (!key) {
      try {
        const { default: Database } = await import("bun:sqlite")
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.elitza/home/data/elitza.db")
        const db = new (Database as any)(dbPath, { readonly: true })
        const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
        if (row?.value) {
          const cred = JSON.parse(row.value)
          if (cred.access) key = cred.access
        }
        db.close()
      } catch (e) { console.error("[enrichment] providerConfig db error:", String(e)) }
    }
    const url = "https://opencode.ai/inference/go/openai/v1"
    const model = "beam-free"
    return { url, key, model }
  }
  const key = process.env.XIAOMI_API_KEY?.trim() ?? ""
  let url = "https://api.xiaomimimo.com/v1"
  try {
    const cfg = JSON.parse(fs.readFileSync(engineConfigPath(), "utf8"))
    const base = cfg?.providers?.elitza?.settings?.baseURL
    if (base) url = String(base).replace(/\/$/, "")
  } catch {
    // fall back to prefix detection
  }
  if (!url || url === "https://api.xiaomimimo.com/v1") {
    if (key.toLowerCase().startsWith("tp")) url = "https://token-plan-ams.xiaomimimo.com/v1"
  }
  const model = "mimo-v2.6-flash"
  return { url, key, model }
}

export interface EnrichmentResult {
  ok: boolean
  client_id: number
  website: string | null
  emails: string[]
  phones: string[]
  socials: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string }
  diagnosis: string
  proposal: string
  price: string
  risk_level: string
  risk_score: number
  risk_notes: string
  tech_stack: string
  revenue_estimate: string
  employee_count: string
  next_action: string
  worksheets: string[]
  error?: string
}

export async function enrichClient(clientId: number): Promise<EnrichmentResult> {
  const client = getClient(clientId)
  if (!client) {
    return { ok: false, client_id: clientId, website: null, emails: [], phones: [], socials: {}, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", worksheets: [], error: `No client with id ${clientId}.` }
  }

  let website = client.website?.trim() || null

  // ---- Resolve a website even when none is on file ----
  // Use location + name to scout for a matching business, and fall back to
  // web search. The goal: never give up just because the website field is empty.
  let scoutMatch: { name: string; website: string | null; phone: string | null; address: string | null } | null = null
  const location = (client.address || "").trim()
  const name = (client.name || "").trim()

  if (!website && (location || name)) {
    // 1. Scout the location with the client name as query (with timeout).
    try {
      const { scoutBusinesses } = await import("./scouting.js")
      const q = name || client.vertical || "business"
      const res: any = await Promise.race([
        scoutBusinesses(location || name, q, 8),
        new Promise((_, rej) => setTimeout(() => rej(new Error("scout timeout")), 6000)),
      ])
      if (res?.businesses?.length) {
        // fuzzy match by name
        const lowerName = name.toLowerCase()
        let best: any = null
        let bestScore = 0
        for (const b of res.businesses) {
          const bn = (b.name || "").toLowerCase()
          let score = 0
          if (bn === lowerName) score = 100
          else if (bn.includes(lowerName) || lowerName.includes(bn)) score = 60
          else {
            // token overlap
            const toks = (s: string) => s.split(/[^a-z0-9]+/).filter(Boolean)
            const a = toks(lowerName), b2 = toks(bn)
            const overlap = a.filter((t) => b2.includes(t)).length
            score = overlap * 20
          }
          if (score > bestScore) { bestScore = score; best = b }
        }
        if (best && bestScore >= 20) {
          scoutMatch = { name: best.name, website: best.website, phone: best.phone, address: best.address }
          if (best.website) website = best.website
          // persist discovered phone/website back to the client
          try {
            const patch: any = {}
            if (best.website && !client.website) patch.website = best.website
            if (best.phone && !client.phone) patch.phone = best.phone
            if (best.address && !client.address) patch.address = best.address
            if (Object.keys(patch).length) updateClient(clientId, patch)
          } catch { /* best effort */ }
        }
      }
    } catch (e) { console.error("[enrichment] scout error:", String(e)) }
  }

  const base = website ? (/^https?:\/\//i.test(website) ? website.replace(/\/$/, "") : `https://${website.replace(/\/$/, "")}`) : null

  // Fetch homepage + common subpages (only if we have a website).
  const pages: { url: string; text: string }[] = []
  const seen = new Set<string>()
  if (base) {
    for (const sub of SUBPAGES) {
      const url = sub === "/" ? base : `${base}${sub}`
      if (seen.has(url)) continue
      seen.add(url)
      const text = await fetchPage(url)
      if (text) pages.push({ url, text })
    }
  }

  // ---- Web search for extra intelligence (name + location + company) ----
  const searchQueries = [
    `"${name}" ${location}`,
    `"${name}" ${client.vertical || ""} ${location}`.trim(),
  ].filter((q) => q.replace(/["\s]/g, "").length > 3)
  const searchSnippets: string[] = []
  for (const q of searchQueries.slice(0, 2)) {
    try {
      const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q)
      const res = await fetch(url, { headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" }, signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const html = await res.text()
        // extract result snippets
        const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripHtml(m[1])).filter(Boolean)
        const titles = [...html.matchAll(/class="result__title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripHtml(m[1])).filter(Boolean)
        for (let i = 0; i < Math.min(snippets.length, 8); i++) {
          searchSnippets.push((titles[i] ? titles[i] + " — " : "") + snippets[i])
        }
      }
    } catch { /* ignore */ }
  }
  if (searchSnippets.length) {
    pages.push({ url: "web-search", text: searchSnippets.join("\n") })
  }
  if (scoutMatch) {
    pages.push({ url: "scout-match", text: `Scouted business match: name="${scoutMatch.name}", website="${scoutMatch.website}", phone="${scoutMatch.phone}", address="${scoutMatch.address}".` })
  }

  if (!pages.length) {
    return { ok: false, client_id: clientId, website: null, emails: [], phones: [], socials: {}, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", worksheets: [], error: "No public information found. Provide a website, or more location/name details, or run scout manually." }
  }

  const allText = pages.map((p) => `--- ${p.url} ---\n${p.text}`).join("\n\n")
  const emails = extractEmails(allText)
  const phones = extractPhones(allText)
  const socials = extractSocials(allText)

  // Persist discovered contact details back to the client record.
  try {
    const patch: any = {}
    if (emails.length && !client.email) patch.email = emails[0]
    if (phones.length && !client.phone) patch.phone = phones[0]
    if (socials.linkedin && !client.linkedin) patch.linkedin = socials.linkedin
    if (socials.twitter && !client.twitter) patch.twitter = socials.twitter
    if (socials.facebook && !client.facebook) patch.facebook = socials.facebook
    if (socials.instagram && !client.instagram) patch.instagram = socials.instagram
    if (Object.keys(patch).length) updateClient(clientId, patch)
  } catch { /* best effort */ }

  // Read playbooks.
  const diagnosisPlaybook = readPlaybook("ai-enablement-diagnosis")
  const proposalPlaybook = readPlaybook("fixed-scope-proposal")
  const paymentPlaybook = readPlaybook("payment-terms")

  const { url: mimoUrl, key: mimoKey, model: configModel } = await providerConfig()
  let model = configModel
  let variant = ""
  try {
    const { soulGet } = await import("./soul.js")
    const saved = soulGet("chat_model", "")
    if (saved) model = saved
    variant = soulGet("chat_variant", "")
  } catch {}
  if (!mimoKey) {
    const provider = process.env.ELITZA_CHAT_PROVIDER || "opencode-go"
    const keyName = provider === "opencode-go" ? "OpenCode Go plan (connect in CRM Settings)" : "XIAOMI_API_KEY"
    return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", worksheets: [], error: keyName + " is not set." }
  }

  const systemPrompt = `You are Elitza, an AI Enablement operator. You scout local businesses and design fixed-scope AI enablement sprints (EUR 1,500-3,500). You are given a business's public website content and your own playbooks. Produce a DEEP, honest enrichment report — your goal is to discover EVERYTHING publicly known about this person and company (the "secrets"). Never invent facts; mark unknowns as "unknown" and inferences as "inferred (low confidence)".

You have a "deep-enrichment" skill available — follow its checklist and method. Discover:
- Person: full name, title, company, location, email (work+personal), phone, LinkedIn, Twitter/X, GitHub, website, background, education, publications, talks, awards, recent posts, network signals.
- Company: legal name, domain, industry, founded, founders, HQ, employee count, funding rounds/investors, revenue estimate, tech stack, products, target customers, recent news, open jobs, competitors, partnerships, reviews, social presence.
Cross-reference and verify across sources. Cite URLs. Prioritize recent info and B2B-relevant signals (decision power, budget, pain, timing).

OPERATING PLAYBOOKS (follow these):

=== DIAGNOSIS PLAYBOOK ===
${diagnosisPlaybook}

=== PROPOSAL PLAYBOOK ===
${proposalPlaybook}

=== PAYMENT TERMS PLAYBOOK ===
${paymentPlaybook}`

  const userPrompt = `Business: ${client.name}
Vertical: ${client.vertical ?? "unknown"}
Address: ${client.address ?? "unknown"}
Phone (on file): ${client.phone ?? "none"}
Website: ${base}
Emails found on site: ${emails.join(", ") || "none"}
Phones found on site: ${phones.join(", ") || "none"}
Social profiles found: ${Object.entries(socials).map(([k,v]) => `${k}=${v}`).join(", ") || "none"}

WEBSITE CONTENT:
${allText.slice(0, 12000)}

Produce the enrichment report in this exact format:

DIAGNOSIS:
<2-4 sentences: what the business does, who it serves, current state, volume hints, what breaks. Mark unknowns.>

PAIN_POINTS:
- <bullet 1>
- <bullet 2>
- <bullet 3>

RECOMMENDED_SERVICE:
<one of: single flow EUR 1,500 | two or three flows with CRM EUR 2,500 | document processing with retention EUR 3,500 — and why>

SCOPE:
- <bullet 1: concrete artifact>
- <bullet 2>
- <bullet 3>

PRICE:
<EUR amount and one-line justification>

RISK_LEVEL:
<low | medium | high — assessment of: will they pay? are they financially healthy? do they have budget? red flags like no website, no email, sole proprietor with no staff, declining reviews, etc.>

RISK_SCORE:
<0-100 integer, higher = safer bet>

RISK_NOTES:
<2-3 sentences: why this risk level, what signals you used (review count, site quality, business size, vertical stability, payment terms fit).>

TECH_STACK:
<comma-separated list of technologies/tools detected on their site (CMS, booking tools, CRM, analytics, etc.) or "unknown">

REVENUE_ESTIMATE:
<rough monthly revenue band if inferable (e.g. "EUR 5k-15k/mo") or "unknown">

EMPLOYEE_COUNT:
<rough headcount if inferable (e.g. "1-3", "5-10", "20+") or "unknown">

NEXT_ACTION:
<one sentence: what the operator should do next>

Do not include anything outside these sections.`

  let responseText = ""
  try {
    const provider = process.env.ELITZA_CHAT_PROVIDER || "opencode-go"
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${mimoKey}`,
    }
    if (provider === "opencode-go") {
      try {
        const fs = await import("node:fs")
        // read org ID from opencode.db
        const Database = (await import("bun:sqlite")).default
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.elitza/home/data/elitza.db")
        const db = new Database(dbPath, { readonly: true })
        const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
        if (row?.value) {
          const cred = JSON.parse(row.value)
          if (cred.metadata?.orgID) headers["x-opencode-org-id"] = cred.metadata.orgID
        }
        db.close()
      } catch { /* ignore */ }
      headers["x-opencode-session"] = "elitza-enrich-" + Date.now()
    }
    const res = await fetch(`${mimoUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error("[enrichment] LLM HTTP error:", res.status, detail.slice(0, 200))
      return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", worksheets: [], error: `MiMo HTTP ${res.status}: ${detail.slice(0, 200)}` }
    }
    const raw = await res.text()
    let data: any = {}
    try { data = JSON.parse(raw) } catch { console.error("[enrichment] JSON parse failed") }
    const msg = data.choices?.[0]?.message || {}
    responseText = msg.content || msg.reasoning_content || ""
  } catch (error) {
    return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", worksheets: [], error: `MiMo call failed: ${String(error)}` }
  }

  // Parse sections.
  function section(name: string): string {
    const re = new RegExp(`${name}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "i")
    const m = responseText.match(re)
    return m ? m[1].trim() : ""
  }
  const diagnosis = section("DIAGNOSIS")
  const painPoints = section("PAIN_POINTS")
  const recommended = section("RECOMMENDED_SERVICE")
  const scope = section("SCOPE")
  const price = section("PRICE")
  const riskLevel = section("RISK_LEVEL").toLowerCase().trim()
  const riskScoreRaw = section("RISK_SCORE").trim()
  const riskScore = parseInt(riskScoreRaw, 10)
  const riskNotes = section("RISK_NOTES")
  const techStack = section("TECH_STACK")
  const revenueEstimate = section("REVENUE_ESTIMATE")
  const employeeCount = section("EMPLOYEE_COUNT")
  const nextAction = section("NEXT_ACTION")

  const fullDiagnosis = ([diagnosis, painPoints ? `\nPain points:\n${painPoints}` : ""].filter(Boolean).join("") || responseText.slice(0, 2000))
  const fullProposal = ([recommended ? `Recommended service: ${recommended}` : "", scope ? `\nScope:\n${scope}` : "", price ? `\nPrice: ${price}` : ""].filter(Boolean).join("\n") || responseText.slice(0, 2000))

  // Write to CRM.
  let pulledWorksheets: string[] = []
  try {
    // Mark as enriched (move out of the first/scouted stage) so enriched leads
    // are discoverable by status filter.
    // Only move to "enriched" if "enriched" exists in the configured pipeline
    // and the client is currently in a first-stage (or unknown) state.
    const { stageExists, firstConfiguredStage } = await import("./crm.js")
    const first = firstConfiguredStage()
    const firstStage = !client.status || client.status === first || client.status === "scouted" || client.status === "new" || client.status === "stale"
    const canEnrich = stageExists("enriched")
    updateClient(clientId, {
      ...(firstStage && canEnrich ? { status: "enriched" } : {}),
      notes: fullDiagnosis || responseText.slice(0, 2000),
      next_action: nextAction || "Review enrichment and decide on proposal.",
      risk_level: riskLevel || null,
      risk_score: isNaN(riskScore) ? null : riskScore,
      risk_notes: riskNotes || null,
      tech_stack: techStack || null,
      revenue_estimate: revenueEstimate || null,
      employee_count: employeeCount || null,
      linkedin: socials.linkedin ?? client.linkedin ?? null,
      twitter: socials.twitter ?? client.twitter ?? null,
      facebook: socials.facebook ?? client.facebook ?? null,
      instagram: socials.instagram ?? client.instagram ?? null,
    })
    // Fill in emails/phones if the client didn't have them.
    if (!client.email && emails.length) updateClient(clientId, { email: emails[0] })
    if (!client.phone && phones.length) updateClient(clientId, { phone: phones[0] })
    logInteraction(clientId, {
      kind: "enrichment",
      direction: "note",
      channel: "web",
      status: "completed",
      subject: `enrichment: ${client.name}`,
      body: responseText,
      occurred_at: new Date().toISOString(),
    })
    // Attach diagnosis + proposal as assets.
    const stamp = new Date().toISOString().slice(0, 10)
    const diagPath = path.join(ELITZA_HOME, "pipeline", stamp, `C${clientId}-diagnosis.md`)
    const propPath = path.join(ELITZA_HOME, "pipeline", stamp, `C${clientId}-proposal.md`)
    fs.mkdirSync(path.dirname(diagPath), { recursive: true })
    fs.writeFileSync(diagPath, `# Diagnosis — ${client.name}\n\n${fullDiagnosis}\n\n---\nRaw enrichment output:\n\n${responseText}\n`)
    fs.writeFileSync(propPath, `# Proposal — ${client.name}\n\n${fullProposal}\n`)
    addAsset(clientId, { kind: "diagnosis", name: `Diagnosis ${stamp}`, path: diagPath, status: "draft" })
    addAsset(clientId, { kind: "proposal", name: `Proposal ${stamp}`, path: propPath, status: "draft" })
    // Pull the best-fit interactive worksheet as the empty template for this case.
    try {
      const pulls = pullRecommendedWorksheet(clientId, 1)
      for (const p of pulls) pulledWorksheets.push(p.worksheet.id)
    } catch {
      // best-effort: never fail enrichment over a worksheet
    }
  } catch (error) {
    return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: fullDiagnosis, proposal: fullProposal, price, risk_level: riskLevel, risk_score: isNaN(riskScore) ? 0 : riskScore, risk_notes: riskNotes, tech_stack: techStack, revenue_estimate: revenueEstimate, employee_count: employeeCount, next_action: nextAction, worksheets: [], error: `CRM write failed: ${String(error)}` }
  }

  return {
    ok: true,
    client_id: clientId,
    website: website || base,
    emails,
    phones,
    socials,
    diagnosis: fullDiagnosis,
    proposal: fullProposal,
    price,
    risk_level: riskLevel || "unknown",
    risk_score: isNaN(riskScore) ? 0 : riskScore,
    risk_notes: riskNotes,
    tech_stack: techStack,
    revenue_estimate: revenueEstimate,
    employee_count: employeeCount,
    next_action: nextAction || "Review enrichment and decide on proposal.",
    worksheets: pulledWorksheets,
  }
}