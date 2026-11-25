/**
 * Scout Y — high-intent AI job-post scout.
 *
 * Scouts companies actively hiring for AI Enablement / AI Operations /
 * Workflow Automation roles. These companies have verified budget and urgent
 * operational pain, making them prime prospects for Track 1 / Track 2.
 */

import { crawlWebsiteHumanWaterfall } from "./scouting.js"

export interface ScoutYParams {
  query: string
  location?: string
  market?: "all" | "it" | "en"
  limit?: number
}

export interface ScoutYLead {
  company_name: string
  job_title: string
  job_url: string
  job_source: string
  job_snippet: string
  location: string
  website: string | null
  email: string | null
  pec: string | null
  phone: string | null
  vat: string | null
  socials: string[]
  detected_language: "it" | "en"
  signals: string[]
  recommended_track: "track_1" | "track_2"
  akli_relevant: boolean
  intent_score: number
  outreach_route: "email_ready" | "pec_only" | "phone_only" | "needs_manual_review"
  crawl_found_at: string | null
}

const STAFFING_AGENCY_RE = /randstad|adecco|manpower|michael page|page personnel|hays|gi group|umana|synergie|openjobmetis|kelly services|robert half|modis|akkodis|alten|capgemini|accenture|deloitte|pwc|kpmg|ey\b/i

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
}

const IT_PRESETS = ["AI Operations", "Automazione AI", "n8n", "Make automation", "AI Specialist", "Agenti AI", "Process Automation"]
const EN_PRESETS = ["AI Operations", "AI Enablement", "Workflow Automation", "n8n", "AI Agent Engineer", "Operations Automation", "AI Integration"]

export const SCOUT_Y_PRESETS = { it: IT_PRESETS, en: EN_PRESETS, all: [...new Set([...IT_PRESETS, ...EN_PRESETS])] }

interface RawJob {
  company_name: string
  job_title: string
  job_url: string
  job_source: string
  job_snippet: string
  location: string
}

async function webSearch(query: string): Promise<{ title: string; snippet: string; link: string }[]> {
  const results: { title: string; snippet: string; link: string }[] = []
  try {
    const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query)
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return results
    const html = await res.text()
    const titles = [...html.matchAll(/class="result__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
    for (let i = 0; i < titles.length; i++) {
      const link = titles[i][1]
      const title = titles[i][2].replace(/<[^>]+>/g, " ").trim()
      const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]+>/g, " ").trim() : ""
      // unwrap ddg redirect
      let finalLink = link
      const uddg = link.match(/uddg=([^&]+)/)
      if (uddg) { try { finalLink = decodeURIComponent(uddg[1]) } catch {} }
      results.push({ title, snippet, link: finalLink })
    }
  } catch { /* ignore */ }
  return results
}

function isStaffingAgency(name: string): boolean {
  return STAFFING_AGENCY_RE.test(name)
}

function parseJobFromResult(r: { title: string; snippet: string; link: string }, location: string): RawJob | null {
  // title often "Job Title - Company" or "Company hiring Job Title"
  let job_title = r.title
  let company_name = ""
  // try split on " - " or " | "
  const parts = r.title.split(/\s[-|·]\s/)
  if (parts.length >= 2) {
    // heuristic: if first part contains job-ish keywords, second is company
    const jobKeywords = /engineer|manager|specialist|analyst|developer|automation|operations|ai|enablement|lead|head/i
    if (jobKeywords.test(parts[0]) && !jobKeywords.test(parts[1])) {
      job_title = parts[0].trim()
      company_name = parts[1].trim()
    } else if (jobKeywords.test(parts[1])) {
      job_title = parts[1].trim()
      company_name = parts[0].trim()
    } else {
      job_title = parts[0].trim()
      company_name = parts[1].trim()
    }
  }
  if (!company_name) {
    // try from snippet "at Company"
    const m = r.snippet.match(/\bat\s+([A-Z][A-Za-z0-9 &.'-]{2,40})/i)
    if (m) company_name = m[1].trim()
  }
  if (!company_name) return null
  if (isStaffingAgency(company_name)) return null
  // source from link domain
  let job_source = "web"
  try {
    const u = new URL(r.link)
    job_source = u.hostname.replace(/^www\./, "")
  } catch {}
  return {
    company_name,
    job_title: job_title || r.title,
    job_url: r.link,
    job_source,
    job_snippet: r.snippet,
    location: location || "",
  }
}

async function resolveCompanyWebsite(company: string, location: string): Promise<string | null> {
  const res = await webSearch(`"${company}" official website ${location}`)
  const skip = /linkedin|indeed|glassdoor|greenhouse|lever|ashby|workable|facebook|instagram|twitter/i
  for (const r of res) {
    try {
      const u = new URL(r.link)
      const host = u.hostname.replace(/^www\./, "")
      if (skip.test(host)) continue
      return `https://${host}`
    } catch {}
  }
  return null
}

function detectSignals(text: string): string[] {
  const signals: string[] = []
  const lower = (text || "").toLowerCase()
  const checks = [
    ["n8n", /n8n/],
    ["Make", /make\.com|make automation|\bmake\b/],
    ["Zapier", /zapier/],
    ["Python", /python/],
    ["LangChain", /langchain/],
    ["AI Agents", /ai agent|agenti ai/],
    ["CRM", /crm|hubspot|salesforce/],
    ["HubSpot", /hubspot/],
    ["Salesforce", /salesforce/],
    ["Customer Support", /customer support|supporto clienti/],
    ["ERP", /erp/],
    ["Data Governance", /data governance|governance dei dati/],
    ["ChatGPT", /chatgpt|llm/],
  ]
  for (const [label, re] of checks) {
    if ((re as RegExp).test(lower)) signals.push(label as string)
  }
  return signals
}

function recommendTrack(jobTitle: string, snippet: string, siteText: string | null, signals: string[]): { track: "track_1" | "track_2"; akli: boolean } {
  const text = `${jobTitle} ${snippet} ${siteText || ""}`.toLowerCase()
  let track: "track_1" | "track_2" = "track_1"
  if (/multi.agent|multi-system|multi system|crm.*erp|erp.*crm|head of ai|ai engineer|20\+|enterprise/i.test(text)) track = "track_2"
  else if (/n8n|make|zapier|workflow|operations|automazione/i.test(text)) track = "track_1"
  const akli = /governance|data privacy|dlp|chatgpt rollout|llm rollout|internal ai/i.test(text)
  return { track, akli }
}

function scoreIntent(lead: { email: string | null; website: string | null; phone: string | null; socials: string[]; signals: string[]; job_title: string }): number {
  let score = 40
  if (lead.email) score += 20
  if (/n8n|make|ai agent|ai operations|workflow/i.test(lead.job_title)) score += 15
  if (lead.website) score += 15
  if (lead.phone || lead.socials.length) score += 10
  return Math.min(100, score)
}

export async function scoutJobIntent(params: ScoutYParams): Promise<{ leads: ScoutYLead[]; steps: string[]; meta: { sources_used: string[] } }> {
  const steps: string[] = []
  const query = (params.query || "").trim()
  const location = (params.location || "").trim()
  const market = params.market || "all"
  const limit = Math.max(1, Math.min(30, params.limit ?? 15))
  const qTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
  const aiTokens = ["ai", "automation", "automazione", "n8n", "make", "workflow", "agent", "enablement", "integration", "machine learning", "llm"]
  if (!query) return { leads: [], steps: ["❌ query required"], meta: { sources_used: [] } }

  const isIt = market === "it" || /italy|italia|milan|milano|rome|roma/i.test(location)
  const rawJobs: RawJob[] = []
  const sourcesUsed: string[] = []

  // 1. ATS boards via web search
  steps.push("🔍 Searching ATS boards (Greenhouse/Lever/Ashby/Workable)…")
  const atsDomains = ["boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "apply.workable.com"]
  const atsRes: { title: string; snippet: string; link: string }[] = []
  const atsResults = await Promise.allSettled(atsDomains.map((d) => webSearch(`site:${d} ${query} ${location}`)))
  for (const r of atsResults) {
    if (r.status === "fulfilled") atsRes.push(...r.value)
  }
  let n = 0
  for (const r of atsRes) {
    const j = parseJobFromResult(r, location)
    if (j) { rawJobs.push(j); n++ }
  }
  steps.push(`✅ ATS boards: ${n} job(s)`)
  if (n) sourcesUsed.push("ats_boards")

  // 2. Regional job boards
  steps.push("🔍 Searching regional job boards…")
  const regDomains = isIt ? ["it.linkedin.com/jobs", "it.indeed.com", "infojobs.it"] : ["linkedin.com/jobs", "wellfound.com", "indeed.com"]
  const regRes: { title: string; snippet: string; link: string }[] = []
  const regResults = await Promise.allSettled(regDomains.map((d) => webSearch(`site:${d} ${query} ${location}`)))
  for (const r of regResults) {
    if (r.status === "fulfilled") regRes.push(...r.value)
  }
  let rn = 0
  for (const r of regRes) {
    const j = parseJobFromResult(r, location)
    if (j) { rawJobs.push(j); rn++ }
  }
  steps.push(`✅ Regional boards: ${rn} job(s)`)
  if (rn) sourcesUsed.push("regional_boards")

  // 3. Remotive JSON
  steps.push("🔍 Querying Remotive remote jobs…")
  try {
    const res = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) })
    if (res.ok) {
      const data = await res.json() as any
      const jobs = Array.isArray(data.jobs) ? data.jobs : []
      let rc = 0
      for (const j of jobs) {
        const company = String(j.company_name || "").trim()
        if (!company || isStaffingAgency(company)) continue
        const title = String(j.title || "")
        const tags = Array.isArray(j.tags) ? j.tags.join(" ") : ""
        const desc = String(j.description || "")
        const titleLower = title.toLowerCase()
        const fullHaystack = `${title} ${tags} ${desc}`.toLowerCase()
        const matchesQuery = qTokens.length ? qTokens.every((t) => fullHaystack.includes(t)) : true
        const matchesAI = aiTokens.some((t) => new RegExp("\\b" + t + "\\b", "i").test(titleLower))
        // Require an AI/automation signal in the TITLE itself
        const queryInTitle = qTokens.length ? qTokens.every((t) => new RegExp("\\b" + t + "\\b", "i").test(titleLower)) : true
        if (!matchesAI && !queryInTitle) continue
        rawJobs.push({
          company_name: company,
          job_title: title || query,
          job_url: String(j.url || ""),
          job_source: "remotive.com",
          job_snippet: desc.replace(/<[^>]+>/g, " ").slice(0, 300),
          location: String(j.candidate_required_location || "Remote"),
        })
        rc++
      }
      steps.push(`✅ Remotive: ${rc} job(s)`)
      if (rc) sourcesUsed.push("remotive")
    }
  } catch { steps.push("⚠️ Remotive failed") }

  // 3b. RemoteOK JSON
  steps.push("🔍 Querying RemoteOK…")
  try {
    const res = await fetch("https://remoteok.com/api", { headers: { ...BROWSER_HEADERS, "Accept": "application/json" }, signal: AbortSignal.timeout(8000) })
    if (res.ok) {
      const data = await res.json() as any
      const jobs = Array.isArray(data) ? data.slice(1) : []
      const qLower = query.toLowerCase()
      let rc = 0
      for (const j of jobs) {
        const title = String(j.position || "")
        const company = String(j.company || "").trim()
        if (!company || isStaffingAgency(company)) continue
        const tags = Array.isArray(j.tags) ? j.tags.join(" ") : ""
        const titleLower = title.toLowerCase()
        const matchesAI = aiTokens.some((t) => new RegExp("\\b" + t + "\\b", "i").test(titleLower))
        const matchesQuery = qTokens.length ? qTokens.every((t) => new RegExp("\\b" + t + "\\b", "i").test(titleLower)) : true
        if (!matchesAI) continue
        rawJobs.push({
          company_name: company,
          job_title: title || query,
          job_url: String(j.url || ("https://remoteok.com/remote-jobs/" + (j.slug || ""))),
          job_source: "remoteok.com",
          job_snippet: String(j.description || "").replace(/<[^>]+>/g, " ").slice(0, 300),
          location: "Remote",
        })
        rc++
        if (rc >= 10) break
      }
      steps.push(`✅ RemoteOK: ${rc} job(s)`)
      if (rc) sourcesUsed.push("remoteok")
    }
  } catch { steps.push("⚠️ RemoteOK failed") }

  // 4. Arbeitnow JSON
  steps.push("🔍 Querying Arbeitnow job board…")
  try {
    const res = await fetch("https://www.arbeitnow.com/api/job-board-api", { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) })
    if (res.ok) {
      const data = await res.json() as any
      const jobs = Array.isArray(data.data) ? data.data : []
      const qLower = query.toLowerCase()
      let ac = 0
      for (const j of jobs) {
        const title = String(j.title || "")
        const tags = Array.isArray(j.tags) ? j.tags.join(" ") : ""
        if (!title.toLowerCase().includes(qLower) && !tags.toLowerCase().includes(qLower)) continue
        const company = String(j.company_name || "").trim()
        if (!company || isStaffingAgency(company)) continue
        rawJobs.push({
          company_name: company,
          job_title: title,
          job_url: String(j.url || ""),
          job_source: "arbeitnow.com",
          job_snippet: String(j.description || "").replace(/<[^>]+>/g, " ").slice(0, 300),
          location: String(j.location || "Remote"),
        })
        ac++
      }
      steps.push(`✅ Arbeitnow: ${ac} job(s)`)
      if (ac) sourcesUsed.push("arbeitnow")
    }
  } catch { steps.push("⚠️ Arbeitnow failed") }

  // 5. JSearch optional
  if (process.env.JSEARCH_API_KEY) {
    steps.push("🔍 Querying JSearch (RapidAPI)…")
    try {
      const res = await fetch(`https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query + " " + location)}&num_pages=1`, {
        headers: { "X-RapidAPI-Key": process.env.JSEARCH_API_KEY, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" },
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const data = await res.json() as any
        const jobs = Array.isArray(data.data) ? data.data : []
        let jc = 0
        for (const j of jobs) {
          const company = String(j.employer_name || "").trim()
          if (!company || isStaffingAgency(company)) continue
          rawJobs.push({
            company_name: company,
            job_title: String(j.job_title || query),
            job_url: String(j.job_apply_link || j.job_google_link || ""),
            job_source: "jsearch",
            job_snippet: String(j.job_description || "").slice(0, 300),
            location: String(j.job_city || location || ""),
          })
          jc++
        }
        steps.push(`✅ JSearch: ${jc} job(s)`)
        if (jc) sourcesUsed.push("jsearch")
      }
    } catch { steps.push("⚠️ JSearch failed") }
  }

  // Dedup companies by normalized name/domain
  const seenCompanies = new Set<string>()
  const uniqueJobs: RawJob[] = []
  for (const j of rawJobs) {
    const key = j.company_name.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (seenCompanies.has(key)) continue
    seenCompanies.add(key)
    uniqueJobs.push(j)
  }
  steps.push(`🔀 Deduplicated to ${uniqueJobs.length} unique companies.`)

  // Resolve websites + crawl with concurrency 4
  steps.push("🌐 Resolving company websites & crawling…")
  const leads: ScoutYLead[] = []
  const toProcess = uniqueJobs.slice(0, limit)
  let idx = 0
  const workers = 4
  const runOne = async () => {
    while (idx < toProcess.length) {
      const cur = idx++
      const job = toProcess[cur]
      let website: string | null = null
      try { website = await resolveCompanyWebsite(job.company_name, job.location || location) } catch {}
      let intel: any = null
      if (website) {
        try { intel = await crawlWebsiteHumanWaterfall(website) } catch {}
      }
      const email = intel?.email ?? null
      const pec = intel?.pec ?? null
      const phone = intel?.phone ?? null
      const vat = intel?.vat ?? null
      const socials = intel?.socials ?? []
      const detected_language: "it" | "en" = intel?.detected_language ?? (isIt ? "it" : "en")
      const site_text = intel?.site_text ?? null
      const crawl_found_at = intel?.found_at_step ?? null
      const signals = detectSignals(`${job.job_title} ${job.job_snippet} ${site_text || ""}`)
      const { track, akli } = recommendTrack(job.job_title, job.job_snippet, site_text, signals)
      const outreach_route = email ? "email_ready" : (pec ? "pec_only" : (phone ? "phone_only" : "needs_manual_review"))
      const lead: ScoutYLead = {
        company_name: job.company_name,
        job_title: job.job_title,
        job_url: job.job_url,
        job_source: job.job_source,
        job_snippet: job.job_snippet,
        location: job.location || location,
        website,
        email,
        pec,
        phone,
        vat,
        socials,
        detected_language,
        signals,
        recommended_track: track,
        akli_relevant: akli,
        intent_score: 0,
        outreach_route,
        crawl_found_at,
      }
      lead.intent_score = scoreIntent({ email, website, phone, socials, signals, job_title: job.job_title })
      leads.push(lead)
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(workers, toProcess.length) }, () => runOne()))
  steps.push(`✅ Built ${leads.length} Scout Y leads.`)

  leads.sort((a, b) => b.intent_score - a.intent_score)
  return { leads, steps, meta: { sources_used: sourcesUsed } }
}
