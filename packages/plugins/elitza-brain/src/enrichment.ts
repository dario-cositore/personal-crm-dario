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
import { AI_ENABLEMENT_HOME } from "./db.js"
import { engineConfigPath } from "./configview.js"
import { pullRecommendedWorksheet, recommendWorksheets } from "./worksheets.js"

const PLAYBOOK_DIR = path.join(AI_ENABLEMENT_HOME, "brain", "procedural")
const SUBPAGES = ["/", "/about", "/about-us", "/about.html", "/chi-siamo", "/chi-siamo/", "/services", "/servizi", "/contact", "/contatti", "/contact-us", "/pages/about", "/pages/about-us", "/pages/chi-siamo", "/pages/servizi", "/pages/servizi/", "/pages/services", "/pages/contact", "/pages/contatti", "/pages/chi-siamo/", "/pages/home", "/pages/chi-sono", "/pages/chi-siamo", "/shop", "/store", "/negozio", "/farmacia"]

function readPlaybook(name: string, lang?: string): string {
  const l = (lang || "en").toLowerCase()
  const candidates = [
    path.join(PLAYBOOK_DIR, l, `${name}.md`),
    path.join(PLAYBOOK_DIR, `${name}.${l}.md`),
    path.join(PLAYBOOK_DIR, `${name}.md`),
  ]
  for (const c of candidates) {
    try { return fs.readFileSync(c, "utf8") } catch { /* try next */ }
  }
  return ""
}

/** Smartly truncate text for the LLM: keep head + tail + lines containing
 *  high-value keywords, instead of blindly slicing the first N chars. */
function smartExcerpt(text: string, max = 16000): string {
  if (text.length <= max) return text
  const keywords = /email|e-mail|mail|phone|tel|contact|contatt|about|chi.siamo|servizi|services|orari|hours|address|indirizzo|facebook|instagram|linkedin|twitter/i
  const lines = text.split(/\n+/)
  const head = text.slice(0, Math.floor(max * 0.35))
  const tail = text.slice(-Math.floor(max * 0.2))
  const mid: string[] = []
  let midBudget = max - head.length - tail.length
  for (const ln of lines) {
    if (midBudget <= 0) break
    if (keywords.test(ln)) {
      const chunk = ln.slice(0, 400)
      if (midBudget >= chunk.length) { mid.push(chunk); midBudget -= chunk.length + 1 }
    }
  }
  return (head + "\n...\n" + mid.join("\n") + "\n...\n" + tail).slice(0, max + 500)
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
  linkedin: /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s"'<>]+/gi,
  twitter: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/gi,
  facebook: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/[^\s"'<>]+/gi,
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s"'<>]+/gi,
}

async function fetchPage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return ""
    const html = await res.text()
    // No hard cap: return the full stripped text so contact details anywhere
    // (footer, deep pages) are never lost. Truncation happens smartly later.
    return stripHtml(html)
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
    if (m && m[0]) {
      let v = m[0].replace(/[.,;:]+$/, "")
      // unwrap duckduckgo redirect params
      const uddg = v.match(/uddg=([^&]+)/)
      if (uddg) { try { v = decodeURIComponent(uddg[1]) } catch {} }
      // percent-decode if needed
      if (v.includes("%2F") || v.includes("%2f")) { try { v = decodeURIComponent(v) } catch {} }
      // strip query/params
      v = v.split("?")[0].split("#")[0].split("&")[0].replace(/&amp;.*$/, "")
      if (!/^https?:\/\//i.test(v)) v = "https://" + v.replace(/^\/\//, "")
      result[key as keyof typeof result] = v
    }
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
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
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

export async function enrichClient(clientId: number, opts?: { onProgress?: (line: string) => void }): Promise<EnrichmentResult> {
  const log = (line: string) => { try { opts?.onProgress?.(line) } catch {} }
  const client = getClient(clientId)
  if (!client) {
    return { ok: false, client_id: clientId, website: null, emails: [], phones: [], socials: {}, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", worksheets: [], error: `No client with id ${clientId}.` }
  }

  log(`Starting enrichment for "${client.name}"…`)
  if (client.email) log(`Email on file: ${client.email}`)
  if (client.address) log(`Location: ${client.address}`)
  let website = client.website?.trim() || null

  // ---- Resolve a website even when none is on file ----
  // Use location + name to scout for a matching business, and fall back to
  // web search. The goal: never give up just because the website field is empty.
  let scoutMatch: { name: string; website: string | null; phone: string | null; address: string | null } | null = null
  const location = (client.address || "").trim()
  const name = (client.name || "").trim()

  // Email-domain scouting: if the only signal is an email, use its domain
  // (unless it's a famous provider like gmail.com).
  const FAMOUS_EMAIL_DOMAINS = new Set([
    // Global free providers
    "gmail.com","googlemail.com","yahoo.com","yahoo.co.uk","yahoo.fr","yahoo.de","yahoo.it","yahoo.es","yahoo.ca","yahoo.com.au","yahoo.com.br","hotmail.com","hotmail.co.uk","hotmail.fr","hotmail.it","hotmail.de","hotmail.es","outlook.com","outlook.it","outlook.de","outlook.fr","outlook.es","live.com","live.it","live.fr","live.de","live.co.uk","icloud.com","me.com","aol.com","aol.co.uk","protonmail.com","proton.me","protonmail.ch","gmx.com","gmx.net","gmx.de","gmx.at","gmx.ch","mail.com","yandex.com","yandex.ru","yandex.ua","yandex.by","yandex.kz","zoho.com","zohomail.com","fastmail.com","fastmail.fm","tutanota.com","tutanota.de","tutamail.com","qq.com","163.com","126.com","sina.com","sina.cn","naver.com","daum.net","hanmail.net","web.de","t-online.de","freenet.de","gmx.fr","orange.fr","free.fr","laposte.net","sfr.fr","bbox.fr","tiscali.it","libero.it","virgilio.it","alice.it","tim.it","tin.it","aruba.it","pec.it","poste.it","katamail.com","inwind.it","iol.it","vodafone.it",
    // Russian / CIS hosting
    "mail.ru","bk.ru","list.ru","inbox.ru","internet.ru","mail.ua","ukr.net","i.ua","meta.ua","bigmir.net","rambler.ru","lenta.ru","autorambler.ru","myrambler.ru","ro.ru","nm.ru","km.ru","mail.by",
    // Other regional
    "wp.pl","o2.pl","interia.pl","onet.pl","gazeta.pl","abv.bg","mail.bg","dir.bg","seznam.cz","centrum.cz","atlas.cz","volny.cz","post.cz","freemail.hu","citromail.hu","mailbox.hu","indamail.hu","freemail.sk","zoznam.sk","azet.sk","centrum.sk","net.hr","t-com.hr","vip.hr","iskon.hr","telenet.be","skynet.be","scarlet.be","bluewin.ch","sunrise.ch","hispeed.ch","swissonline.ch","blueyonder.co.uk","btinternet.com","sky.com","virginmedia.com","talktalk.net","ntlworld.com","o2.co.uk","ee.co.uk","three.co.uk","vodafone.co.uk","orange.net","wanadoo.co.uk","freeserve.co.uk","ntlworld.com","ntl.com","virgin.net","demon.co.uk","pipex.com","plus.net","zen.co.uk",
    // Generic / catch-all hosts often used as email providers
    "email.com","e-mail.com","mail.org","email.org","consultant.com","engineer.com","accountant.com","doctor.com","teacher.com","nurse.com","lawyer.com","chef.net","programmer.net","contractor.net","realtor.com",
  ])
  // If a previously stored website is actually a famous email/hosting provider,
  // ignore it (stale data from older runs) so we re-scout properly.
  if (website) {
    try {
      const dom = new URL(website.includes("://") ? website : "https://" + website).hostname.toLowerCase().replace(/^www\./, "")
      if (FAMOUS_EMAIL_DOMAINS.has(dom)) website = null
    } catch { /* ignore */ }
  }

  const clientEmail = (client.email || "").trim().toLowerCase()
  let emailDomain: string | null = null
  if (!website && clientEmail.includes("@")) {
    const dom = clientEmail.split("@")[1]
    if (dom && !FAMOUS_EMAIL_DOMAINS.has(dom)) {
      emailDomain = dom
      website = dom
      log(`Email domain "${dom}" is not a public provider → treating as company website.`)
    } else if (dom) {
      log(`Email domain "${dom}" is a public provider → skipping domain-as-website.`)
    }
  }

  if (!website && (location || name)) {
    log(`No website on file → scouting location "${location || name}" for "${name}"…`)
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
          log(`Scout match: "${best.name}" (score ${bestScore})${best.website ? " → " + best.website : ""}`)
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
  if (base) log(`Fetching website: ${base}`)

  // Fetch homepage + common subpages (only if we have a website).
  const pages: { url: string; text: string }[] = []
  const seen = new Set<string>()
  const allSocials: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string } = {}
  if (base) {
    for (const sub of SUBPAGES) {
      const url = sub === "/" ? base : `${base}${sub}`
      if (seen.has(url)) continue
      seen.add(url)
      // Fetch raw html to extract social links even from scripts.
      let raw = ""
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" }, signal: AbortSignal.timeout(8000) })
        if (res.ok) raw = await res.text()
      } catch { /* ignore */ }
      const text = raw ? stripHtml(raw).slice(0, 20000) : ""
      // Extract socials from raw html (catches links in scripts/meta).
      const rs = extractSocials(raw)
      for (const k of Object.keys(rs) as (keyof typeof rs)[]) { if (rs[k] && !allSocials[k]) allSocials[k] = rs[k] }
      if (text) pages.push({ url, text })
    }
  }

  // ---- Web search for extra intelligence (name + location + company) ----
  const localPart = clientEmail ? clientEmail.split("@")[0] : ""

  // Infer a country calling code from the email domain TLD / address.
  function inferCountryCode(): string {
    const dom = clientEmail.split("@")[1] || ""
    const addr = (client?.address || "").toLowerCase()
    if (dom.endsWith(".co.uk") || dom.endsWith(".org.uk") || dom.endsWith(".me.uk") || addr.includes("uk") || addr.includes("united kingdom") || addr.includes("england") || addr.includes("scotland") || addr.includes("wales")) return "+44"
    if (dom.endsWith(".it") || addr.includes("italy") || addr.includes("italia")) return "+39"
    if (dom.endsWith(".de") || addr.includes("germany") || addr.includes("deutschland")) return "+49"
    if (dom.endsWith(".fr") || addr.includes("france")) return "+33"
    if (dom.endsWith(".es") || addr.includes("spain") || addr.includes("españa")) return "+34"
    if (dom.endsWith(".nl") || addr.includes("netherlands")) return "+31"
    if (dom.endsWith(".be") || addr.includes("belgium")) return "+32"
    if (dom.endsWith(".ch") || addr.includes("switzerland")) return "+41"
    if (dom.endsWith(".at") || addr.includes("austria")) return "+43"
    if (dom.endsWith(".pl") || addr.includes("poland")) return "+48"
    if (dom.endsWith(".ru") || addr.includes("russia")) return "+7"
    if (dom.endsWith(".ua") || addr.includes("ukraine")) return "+380"
    if (dom.endsWith(".com") || dom.endsWith(".net") || dom.endsWith(".org")) return "+1"
    return ""
  }
  const countryCode = inferCountryCode()

  // Normalize phone: strip spaces/dashes; build variants with country code.
  const rawPhone = (client.phone || "").trim()
  const phoneDigits = rawPhone.replace(/[^0-9+]/g, "")
  const phoneVariants: string[] = []
  if (phoneDigits) {
    phoneVariants.push(phoneDigits)
    if (!phoneDigits.startsWith("+") && countryCode) {
      // drop leading 0 for country code
      const stripped = phoneDigits.replace(/^0+/, "")
      phoneVariants.push(countryCode + stripped)
      phoneVariants.push(countryCode + " " + stripped)
    }
    // also try with spaces preserved (original)
    if (rawPhone && rawPhone !== phoneDigits) phoneVariants.push(rawPhone)
  }

  const searchQueries = [
    // Full email first
    clientEmail ? `"${clientEmail}"` : "",
    // Then the username/local-part alone (often reused across platforms)
    localPart && localPart.length >= 4 ? `"${localPart}"` : "",
    localPart && localPart.length >= 4 ? `${localPart} profile` : "",
    // Name + location
    `"${name}" ${location}`,
    `"${name}" ${client.vertical || ""} ${location}`.trim(),
    // Social profile lookups
    `"${name}" facebook`,
    `"${name}" linkedin`,
    // Phone lookups (with inferred country code)
    ...phoneVariants.map((p) => `"${p}"`),
    ...phoneVariants.map((p) => `"${p}" ${name}`.trim()),
    // Domain (only if not a famous provider)
    emailDomain ? `"${emailDomain}"` : "",
  ].filter((q) => q.replace(/["\s]/g, "").length > 3)
  const searchSnippets: string[] = []
  if (phoneVariants.length) log(`Phone variants to search: ${phoneVariants.join(", ")} (country code ${countryCode || "none"})`)
  log(`Running web search (${searchQueries.length} queries)…`)
  for (const q of searchQueries.slice(0, 8)) {
    try {
      const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q)
      const res = await fetch(url, { headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" }, signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const html = await res.text()
        // extract result snippets
        const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripHtml(m[1])).filter(Boolean)
        const titles = [...html.matchAll(/class="result__title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripHtml(m[1])).filter(Boolean)
        const links = [...html.matchAll(/class="result__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/gi)].map((m) => m[1]).filter(Boolean)
        for (let i = 0; i < Math.min(Math.max(snippets.length, titles.length), 8); i++) {
          const link = links[i] ? " [" + links[i] + "]" : ""
          searchSnippets.push((titles[i] ? titles[i] + " — " : "") + (snippets[i] || "") + link)
        }
        // Capture any social-profile URLs present in the raw result page.
        // Capture social-profile URLs, including URL-encoded (duckduckgo redirect) forms.
        const socialUrls = html.match(/(?:https?:\/\/)?(?:www\.)?(?:facebook|twitter|x|linkedin|instagram)\.com[^"'\s<>]*/gi) || []
        for (const u of new Set(socialUrls)) {
          let v = u.replace(/[.,;:]+$/, "")
          const uddg = v.match(/uddg=([^&]+)/)
          if (uddg) { try { v = decodeURIComponent(uddg[1]) } catch {} }
          if (v.includes("%2F") || v.includes("%2f") || v.includes("%3A") || v.includes("%3a")) { try { v = decodeURIComponent(v) } catch {} }
          // strip query/fragment/params
          v = v.split("?")[0].split("#")[0].split("&")[0]
          v = v.replace(/&amp;.*$/, "")
          if (!/^https?:\/\//i.test(v)) v = "https://" + v.replace(/^\/\//, "")
          if (/facebook|twitter|x\.com|linkedin|instagram/i.test(v)) searchSnippets.push("Social profile URL: " + v)
        }
      }
    } catch { /* ignore */ }
  }
  if (searchSnippets.length) {
    pages.push({ url: "web-search", text: searchSnippets.join("\n") })
  }
  // Sitemap-based discovery: fetch /sitemap.xml and pull a few relevant pages.
  if (base) {
    try {
      const smRes = await fetch(base + "/sitemap.xml", { headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" }, signal: AbortSignal.timeout(8000) })
      if (smRes.ok) {
        const smXml = await smRes.text()
        let locs = [...smXml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim().replace(/&amp;/g, "&"))
        // If this is a sitemap index, follow sub-sitemaps that look like pages.
        if (/sitemap.*index|<sitemapindex/i.test(smXml)) {
          const subMaps = locs.filter((u) => /pages/i.test(u))
          const collected: string[] = []
          for (const sm of subMaps.slice(0, 3)) {
            try {
              const r = await fetch(sm, { headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" }, signal: AbortSignal.timeout(8000) })
              if (r.ok) {
                const x = await r.text()
                collected.push(...[...x.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim().replace(/&amp;/g, "&")))
              }
            } catch { /* ignore */ }
          }
          if (collected.length) locs = collected
        }
        const relevant = locs.filter((u) => /about|chi-siamo|servizi|services|contatt|contact|team|chi-sono/i.test(u))
        log(`Sitemap found ${locs.length} URLs; ${relevant.length} relevant.`)
        for (const u of relevant.slice(0, 6)) {
          if (seen.has(u)) continue
          seen.add(u)
          let raw = ""
          try {
            const res = await fetch(u, { headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" }, signal: AbortSignal.timeout(8000) })
            if (res.ok) raw = await res.text()
          } catch { /* ignore */ }
          const text = raw ? stripHtml(raw).slice(0, 20000) : ""
          const rs = extractSocials(raw)
          for (const k of Object.keys(rs) as (keyof typeof rs)[]) { if (rs[k] && !allSocials[k]) allSocials[k] = rs[k] }
          if (text) pages.push({ url: u, text })
        }
      }
    } catch { /* ignore */ }
  }

  if (scoutMatch) {
    pages.push({ url: "scout-match", text: `Scouted business match: name="${scoutMatch.name}", website="${scoutMatch.website}", phone="${scoutMatch.phone}", address="${scoutMatch.address}".` })
  }

  if (!pages.length) {
    log("No public information found.")
    return { ok: false, client_id: clientId, website: null, emails: [], phones: [], socials: {}, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", worksheets: [], error: "No public information found. Provide a website, or more location/name details, or run scout manually." }
  }

  const allText = pages.map((p) => `--- ${p.url} ---\n${p.text}`).join("\n\n")
  const emails = extractEmails(allText)
  const phones = extractPhones(allText)
  const socials = { ...allSocials, ...extractSocials(allText) }

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
  const lang = (client as any).language || "en"
  const diagnosisPlaybook = readPlaybook("ai-enablement-diagnosis", lang)
  const proposalPlaybook = readPlaybook("fixed-scope-proposal", lang)
  const paymentPlaybook = readPlaybook("payment-terms", lang)

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

  const systemPrompt = `You are the AI Enablement Agent, an AI Enablement operator. You scout local businesses and design fixed-scope AI enablement sprints (EUR 1,500-3,500). You are given a business's public website content and your own playbooks. Produce a DEEP, honest enrichment report — your goal is to discover EVERYTHING publicly known about this person and company (the "secrets"). Never invent facts; mark unknowns as "unknown" and inferences as "inferred (low confidence)".

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
${smartExcerpt(allText, 16000)}

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
        const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
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
    // Merge discovered contact details: fill when missing, replace when a
    // better/different value is found on this enrichment pass.
    if (emails.length) updateClient(clientId, { email: emails[0] })
    if (phones.length) updateClient(clientId, { phone: phones[0] })
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
    const diagPath = path.join(AI_ENABLEMENT_HOME, "pipeline", stamp, `C${clientId}-diagnosis.md`)
    const propPath = path.join(AI_ENABLEMENT_HOME, "pipeline", stamp, `C${clientId}-proposal.md`)
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