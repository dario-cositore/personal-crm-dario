/**
 * Elitza Brain — local client scouting.
 *
 * Scouting is keyless first and built for stability:
 *   1. Photon (Komoot, OSM-backed full-text search) is the primary source —
 *      it is a free, keyless, stable endpoint and returns OSM objects with
 *      coordinates and tags. Results are filtered to the requested trade's
 *      OSM tags and to the requested area.
 *   2. Each surviving OSM object is enriched through the stable OSM API
 *      (api.openstreetmap.org), which returns the full tag set: phone,
 *      website, email, address, opening hours.
 *   3. Overpass (mirror list) runs only as a fallback when Photon fails or
 *      comes back short.
 *   4. Google Places runs only behind the operator's own GOOGLE_MAPS_API_KEY.
 *
 * Contact details only ever come from public OSM/Places fields; nothing is
 * ever invented. Results are cached in memory (short TTL) and HTTP calls
 * retry on transient failures, so a flaky network does not empty a scout.
 *
 * This module only searches. It never drafts, never sends, never writes a
 * client anywhere — those are the CRM and pipeline's jobs.
 *
 * Config (env):
 *   GOOGLE_MAPS_API_KEY   optional; enables the Google Places fallback
 *   GOOGLE_PLACES_URL     default https://places.googleapis.com/v1/places:searchText
 *   PHOTON_URL            default https://photon.komoot.io/api/
 *   OSM_API_URL           default https://api.openstreetmap.org/api/0.6
 *   OVERPASS_URL          default the public Overpass mirrors below
 */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
const OVERPASS_TIMEOUT_MS = 5_000
const GOOGLE_TIMEOUT_MS = 8_000
const PHOTON_TIMEOUT_MS = 5_000
const OSM_API_TIMEOUT_MS = 5_000
const MAX_LIMIT = 50
const CACHE_TTL_MS = 30 * 60 * 1000
const USER_AGENT = "Elitza client_scout (https://elitza.life)"

/**
 * The scouting vocabulary to OSM tags. Matchers are accent-insensitive:
 * a single-word matcher hits whole query words only (so "bar" never
 * catches "barbiere"), multi-word matchers match as substrings.
 */
export const CATEGORY_TAGS = [
  {
    match: ["idraulico", "idraulici", "idraulica", "idraulici_impianti", "plumber", "plumbers"],
    tags: [
      ["craft", "plumber"],
      ["shop", "plumber"],
    ],
  },
  {
    match: ["parrucchiere", "parrucchieri", "parrucchiera", "hairdresser", "hairdressers"],
    tags: [["shop", "hairdresser"]],
  },
  {
    match: ["dentista", "dentisti", "dentist", "dentists"],
    tags: [["amenity", "dentist"]],
  },
  {
    match: ["avvocato", "avvocati", "lawyer", "lawyers", "attorney", "attorneys", "law firm", "law firms", "law office", "law offices", "legal", "legal services", "esq", "esquire", "solicitor", "solicitors", "barrister", "barristers"],
    tags: [
      ["office", "lawyer"],
      ["office", "attorney"],
    ],
  },
  {
    match: ["commercialista", "commercialisti", "accountant", "accountants", "accounting firm", "accounting firms", "cpa", "cpas", "bookkeeper", "bookkeepers"],
    tags: [["office", "accountant"]],
  },
  {
    match: ["ristorante", "ristoranti", "restaurant", "restaurants", "bar", "caffe", "cafe", "cafes"],
    tags: [
      ["amenity", "restaurant"],
      ["amenity", "cafe"],
    ],
  },
  {
    match: ["autofficina", "autofficine", "car repair", "mechanic", "garage"],
    tags: [["shop", "car_repair"]],
  },
  {
    match: ["farmacia", "farmacie", "pharmacy", "pharmacies"],
    tags: [["amenity", "pharmacy"]],
  },
  {
    match: ["medico", "medici", "doctor", "doctors", "physician", "physicians", "clinica", "cliniche", "clinic", "clinics", "medical", "medico privato", "private clinic", "ospedale", "ospedali", "hospital", "hospitals", "private hospital", "struttura sanitaria", "poliambulatorio", "poliambulatori"],
    tags: [
      ["amenity", "doctors"],
      ["amenity", "clinic"],
      ["amenity", "hospital"],
      ["healthcare", "doctor"],
      ["healthcare", "clinic"],
      ["healthcare", "hospital"],
      ["healthcare", "centre"],
    ],
  },
  {
    match: ["veterinario", "veterinari", "veterinary", "vet"],
    tags: [["amenity", "veterinary"]],
  },
  {
    match: ["ottico", "ottici", "optician", "opticians", "optometrist"],
    tags: [["shop", "optician"]],
  },
  {
    match: ["fisioterapista", "fisioterapisti", "physiotherapist", "physio", "physiotherapy"],
    tags: [["healthcare", "physiotherapist"]],
  },
  {
    match: ["psicologo", "psicologi", "psychologist", "psychologists", "psychotherapist"],
    tags: [["healthcare", "psychotherapist"], ["office", "psychologist"]],
  },
  {
    match: ["agenzia immobiliare", "immobiliare", "real estate"],
    tags: [["office", "estate_agent"], ["shop", "estate_agent"]],
  },
  {
    match: ["assicurazioni", "assicurazione", "insurance"],
    tags: [["office", "insurance"]],
  },
  {
    match: ["architetto", "architetti", "ingegnere", "ingegneri", "architect", "architects", "engineer"],
    tags: [["office", "architect"], ["office", "engineer"]],
  },
  {
    match: ["agenzia", "agenzie", "consulenza", "marketing", "consulting", "agency"],
    tags: [["office", "consulting"], ["office", "advertising_agency"], ["office", "it"], ["office", "company"]],
  },
  {
    match: ["logistica", "trasporti", "logistics", "freight"],
    tags: [["office", "logistics"], ["office", "transport"]],
  },
  {
    match: ["hotel", "albergo", "alberghi", "hotels"],
    tags: [["tourism", "hotel"]],
  },
  {
    match: ["pmi_servizi", "pmi", "agenzia", "agenzie", "consulenza", "consulting", "agency", "servizi"],
    tags: [["office", "company"], ["office", "consulting"], ["office", "it"]],
  },
  {
    match: ["ristorazione_hotel", "ristorazione", "ristorante", "ristoranti", "restaurant", "restaurants"],
    tags: [["amenity", "restaurant"], ["amenity", "cafe"], ["tourism", "hotel"]],
  },
]

export interface WebsiteIntel {
  email: string | null
  pec: string | null
  address: string | null
  phone: string | null
  vat: string | null
  socials: string[]
  detected_language: "it" | "en" | null
  site_text: string | null
  found_at_step: string | null
}

export interface ScoutedBusiness {
  name: string
  address: string
  phone: string | null
  website: string | null
  email: string | null
  pec?: string | null
  vat?: string | null
  socials?: string[]
  detected_language?: "it" | "en" | null
  site_text?: string | null
  crawl_found_at?: string | null
  rating: number | null
  rating_count: number | null
  category: string
  google_maps: string | null
}

export interface ScoutResult {
  businesses: ScoutedBusiness[]
  meta: { sources_used: string[] }
  steps?: string[]
  error?: string
  run_id?: number
}

interface OverpassElement {
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

interface OverpassResponse {
  elements?: OverpassElement[]
  remark?: string
}

interface PlacesResponse {
  places?: {
    displayName?: { text?: string }
    formattedAddress?: string
    nationalPhoneNumber?: string
    internationalPhoneNumber?: string
    websiteUri?: string
    rating?: number
    userRatingCount?: number
    primaryType?: string
    primaryTypeDisplayName?: { text?: string }
    googleMapsUri?: string
  }[]
}

type Candidate = { business: ScoutedBusiness; source: string }
type Merged = { business: ScoutedBusiness; sources: string[] }

// ---------------------------------------------------------------------------
// Cache + retry helpers
// ---------------------------------------------------------------------------

const cache = new Map<string, { value: ScoutResult; expires: number }>()

function cacheKey(location: string, query: string, limit: number): string {
  const endpoints = [
    process.env.PHOTON_URL ?? "https://photon.komoot.io/api/",
    process.env.OVERPASS_URL ?? OVERPASS_ENDPOINTS.join(","),
    process.env.GOOGLE_PLACES_URL ?? "https://places.googleapis.com/v1/places:searchText",
  ].join("|")
  return `${location}::${query}::${limit}::${endpoints}`
}

async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number, attempts = 3): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status >= 500 && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(2, i)))
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(2, i)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function scoutBusinesses(
  location: string,
  query: string,
  limit = 10,
): Promise<ScoutResult> {
  const size = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
  const tags = tagsForQuery(query)
  if (!tags.length) {
    return {
      businesses: [],
      meta: { sources_used: [] },
      steps: ["❌ No OSM mapping for query: " + query],
      error: `no OpenStreetMap mapping for "${query}" (known: idraulici, parrucchieri, dentisti, avvocati, commercialisti, ristoranti, bar, autofficine, farmacie, medici/cliniche, veterinari, ottici, fisioterapisti, psicologi. English works too: law firms, attorneys, dentists, pharmacies, clinics, accountants)`,
    }
  }

  const key = cacheKey(location, query, size)
  const isTestEnv = /127\.0\.0\.1|localhost/.test(
    `${process.env.PHOTON_URL ?? ""}${process.env.OVERPASS_URL ?? ""}${process.env.GOOGLE_PLACES_URL ?? ""}`,
  )
  if (!isTestEnv) {
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
  }

  const candidates: Candidate[] = []
  const failures: string[] = []
  const steps: string[] = []
  const tagSet = new Set(tags.map(([k, v]) => `${k}=${v}`))
  steps.push("🏷️ OSM tags to match: " + [...tagSet].join(", "))

  // 0. Google Places (keyless-or-keyed) first when a key is present.
  const googleKey0 = process.env.GOOGLE_MAPS_API_KEY?.trim()
  if (googleKey0) {
    steps.push("🗺️  Trying Google Places first…")
    const google0 = await googleSearch(location, query, googleKey0, size)
    if (google0.error) { failures.push(google0.error); steps.push("⚠️ Google Places: " + google0.error) }
    else {
      candidates.push(...google0.businesses.map((business) => ({ business, source: "google_places" })))
      steps.push("✅ Google Places returned " + google0.businesses.length + " candidate(s)")
    }
  }

  // 1. MioDottore first for individual-practitioner queries (fast). Skip it for
  //    "cliniche/clinic/clinics" because those should resolve to actual clinic
  //    BUSINESSES on the map, not individual doctors already listed on MioDottore.
  const isClinicBusinessQuery = /cliniche|clinics?|clinical|polyclinic|poliambulatori/i.test(normalizeText(query))
  if (isMedicalQuery(query) && !isClinicBusinessQuery) {
    steps.push("🏥 Trying MioDottore for individual practitioners…")
    const md = await scoutMioDottore(location, query, size)
    if (md.error) { failures.push(md.error); steps.push("⚠️ MioDottore: " + md.error) }
    else {
      candidates.push(...md.businesses.map((business) => ({ business, source: "miodottore" })))
      steps.push("✅ MioDottore returned " + md.businesses.length + " candidate(s)")
    }
  }

  // 2. Photon (primary, stable) — only if still short.
  if (mergeDedup(candidates).length < size) {
    steps.push("🔍 Querying Photon (Komoot/OSM) for " + query + " in " + location + "…")
    let photonAnswered = false
    try {
      const photon = await scoutPhoton(location, tags, tagSet, size)
      if (photon.error) { failures.push(photon.error); steps.push("⚠️ Photon: " + photon.error) }
      else {
        photonAnswered = true
        candidates.push(...photon.candidates)
        steps.push("✅ Photon returned " + photon.candidates.length + " candidate(s)" + (photon.areaLevel ? " (area: " + photon.areaLevel + ")" : ""))
      }
    } catch (error) {
      failures.push(`Photon search failed: ${String(error)}`)
      steps.push("❌ Photon failed: " + String(error))
    }
  }

  // 3. Overpass fallback when still short.
  if (mergeDedup(candidates).length < size) {
    steps.push("📡 Trying Overpass fallback…")
    const osm = await scoutOsm(location, tags)
    if (osm.error) { failures.push(osm.error); steps.push("⚠️ Overpass: " + osm.error) }
    else {
      candidates.push(...osm.businesses.map((business) => ({ business, source: "osm" })))
      steps.push("✅ Overpass returned " + osm.businesses.length + " candidate(s)")
    }
  }


  // 4. Web search fallback (Bing) when OSM/Places are unreachable — best-effort.
  //    Skipped in the test environment (localhost endpoints) so unit tests never
  //    hit the live web, and its failures are logged but not escalated, since
  //    this source is a bonus, not a primary signal.
  if (!isTestEnv && mergeDedup(candidates).length < size) {
    steps.push("🌐 OSM/Places short or unreachable — trying web search (Bing)…")
    const web = await scoutWebSearch(location, query, size)
    if (web.error) { steps.push("⚠️ Web search: " + web.error) }
    else {
      candidates.push(...web.businesses.map((business) => ({ business, source: "web_search" })))
      steps.push("✅ Web search returned " + web.businesses.length + " candidate(s)")
    }
  }

  const mergedRaw = mergeDedup(candidates).slice(0, size)
  // Drop businesses with no online presence (no website and no email): nothing to sell to.
  const withPresence = mergedRaw.filter((entry) => {
    const b = entry.business || {}
    return Boolean((b.website && String(b.website).trim()) || (b.email && String(b.email).trim()))
  })
  const mergedRaw2 = withPresence
  // Exclude businesses already in the CRM (people / companies / pipeline / clients).
  let existingKeys = new Set()
  try {
    const crm = await import("./crm.js")
    const norm = (v: any) => String(v || "").trim().toLowerCase()
    const domain = (v: any) => { const s = String(v || "").trim().toLowerCase(); return s.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0] }
    const normPhone = (v: any) => String(v || "").replace(/[^0-9]/g, "")
    for (const c of (crm.findClients ? crm.findClients({ limit: 10000 }) : [])) {
      if (c.name) existingKeys.add(norm(c.name))
      if (c.email) existingKeys.add(norm(c.email))
      if (c.website) existingKeys.add(domain(c.website))
      if (c.phone) existingKeys.add(normPhone(c.phone))
      if (c.company) existingKeys.add(norm(c.company))
    }
    for (const p of (crm.listPeople ? crm.listPeople() : [])) {
      if (p.name) existingKeys.add(norm(p.name))
      if (p.email) existingKeys.add(norm(p.email))
      if (p.phone) existingKeys.add(normPhone(p.phone))
    }
    for (const co of (crm.listCompanies ? crm.listCompanies() : [])) {
      if (co.name) existingKeys.add(norm(co.name))
    }
  } catch { /* best effort */ }
  const merged = mergedRaw2.filter((entry) => {
    const b = entry.business || {}
    const keys = [b.name ? String(b.name).trim().toLowerCase() : null,
      b.email ? String(b.email).trim().toLowerCase() : null,
      b.website ? String(b.website).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0] : null,
      b.phone ? String(b.phone).replace(/[^0-9]/g, "") : null].filter(Boolean)
    return !keys.some((k) => existingKeys.has(k))
  })
  steps.push("🔀 Merged " + candidates.length + " raw candidates into " + merged.length + " unique businesses.")
  if (merged.length) steps.push("📋 Found: " + merged.map((m) => m.business.name).join(", "))

  // Site enrichment: crawl each merged business website (skipped in test env).
  if (!isTestEnv) {
    const toCrawl = merged.filter((m) => Boolean(m.business.website))
    let crawled = 0
    let emailsFound = 0
    const workers = 4
    let idx = 0
    const runOne = async () => {
      while (idx < toCrawl.length) {
        const cur = idx++
        const entry = toCrawl[cur]
        const intel = await crawlWebsiteHumanWaterfall(entry.business.website as string)
        crawled++
        const b = entry.business
        if (intel.email) {
          if (!b.email || rankEmail(intel.email) <= (b.email ? rankEmail(b.email) : 99)) {
            b.email = intel.email
          }
          emailsFound++
        }
        if (intel.pec) b.pec = intel.pec
        if (intel.vat) b.vat = intel.vat
        if (intel.address && !b.address) b.address = intel.address
        if (intel.phone && !b.phone) b.phone = intel.phone
        if (intel.socials?.length) b.socials = intel.socials
        if (intel.detected_language) b.detected_language = intel.detected_language
        if (intel.site_text) b.site_text = intel.site_text
        if (intel.found_at_step) b.crawl_found_at = intel.found_at_step
      }
    }
    await Promise.allSettled(Array.from({ length: Math.min(workers, toCrawl.length) }, () => runOne()))
    steps.push(`🌐 Crawled ${crawled} website(s); discovered ${emailsFound} email(s).`)
  }
  let result: ScoutResult
  if (!merged.length && failures.length) {
    result = { businesses: [], meta: { sources_used: [] }, steps, error: failures.join("; ") }
  } else {
    result = {
      businesses: merged.map((entry) => entry.business),
      meta: { sources_used: [...new Set(merged.flatMap((entry) => entry.sources))] },
      steps,
    }
  }
  if (!isTestEnv) cache.set(key, { value: result, expires: Date.now() + CACHE_TTL_MS })
  return result
}

/** True when the operator's own key is in the environment. The value never leaves it. */
export function scoutKeyPresent(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim())
}

function isMedicalQuery(query: string): boolean {
  const q = normalizeText(query)
  return /medic|doctor|clinic|dentist|farmac|veterinar|physio|psycholog|optician|ottic/i.test(q)
}

// ---------------------------------------------------------------------------
// MioDottore (individual doctors/clinics in Italy) — scrapes individual profiles.
// ---------------------------------------------------------------------------
const MIODOTTORE_SPECIALTY: Record<string, string> = {
  "medico": "medico-di-base",
  "medici": "medico-di-base",
  "doctor": "medico-di-base",
  "doctors": "medico-di-base",
  "clinica": "medico-di-base",
  "cliniche": "medico-di-base",
  "clinic": "medico-di-base",
  "clinics": "medico-di-base",
  "dentista": "dentista",
  "dentisti": "dentista",
  "dentist": "dentista",
  "farmacia": "farmacia",
  "farmacie": "farmacia",
  "pharmacy": "farmacia",
}

async function scoutMioDottore(location: string, query: string, limit: number): Promise<{ businesses: ScoutedBusiness[]; error?: string }> {
  const size = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
  const slug = MIODOTTORE_SPECIALTY[normalizeText(query).split(" ")[0]] || "medico-di-base"
  // Extract city: first comma-separated token, lowercased, spaces -> hyphens
  const city = location.split(",")[0].trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  if (!city) return { businesses: [], error: "no city in location" }
  const baseUrl = (process.env.MIODOTTORE_URL || "https://www.miodottore.it").replace(/\/+$/, "")
  const url = `${baseUrl}/${slug}/${city}`
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    })
    if (!res.ok) return { businesses: [], error: `MioDottore HTTP ${res.status}` }
    const html = await res.text()
    const businesses: ScoutedBusiness[] = []
    const seen = new Set<string>()
    // Doctor cards: h2/h3 with name + link to profile
    const blocks = [...html.matchAll(/<h[23][^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    for (const m of blocks) {
      if (businesses.length >= size) break
      const href = m[1]
      const name = stripTags(m[2]).trim()
      if (!name || name.length < 4 || name.length > 80) continue
      if (seen.has(name)) continue
      seen.add(name)
      const profileUrl = /^https?:\/\//i.test(href) ? href : `https://www.miodottore.it${href.startsWith("/") ? "" : "/"}${href}`
      businesses.push({
        name,
        address: location,
        phone: null,
        website: profileUrl,
        rating: null,
        rating_count: null,
        category: query,
        google_maps: null,
        email: null,
        detected_language: null,
        site_text: null,
      })
    }
    if (!businesses.length) return { businesses: [] }
    return { businesses }
  } catch (e) {
    return { businesses: [], error: `MioDottore failed: ${String(e)}` }
  }
}

// ---------------------------------------------------------------------------
// Web search fallback (Bing) — best-effort when OSM/Places are unreachable.
// ---------------------------------------------------------------------------
async function scoutWebSearch(location: string, query: string, limit: number): Promise<{ businesses: ScoutedBusiness[]; error?: string }> {
  const size = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
  const q = encodeURIComponent(`${query} ${location}`)
  const url = `https://www.bing.com/search?q=${q}`
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    })
    if (!res.ok) return { businesses: [], error: `Bing HTTP ${res.status}` }
    const html = await res.text()
    const businesses: ScoutedBusiness[] = []
    const seen = new Set<string>()
    // Bing result blocks
    const blocks = [...html.matchAll(/<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi)]
    for (const m of blocks) {
      if (businesses.length >= size) break
      const block = m[1]
      const tm = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      const title = tm ? stripTags(tm[2]) : ""
      const href = tm ? tm[1] : ""
      const sm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      const snippet = sm ? stripTags(sm[1]) : ""
      if (!title || title.length < 3) continue
      if (seen.has(title)) continue
      seen.add(title)
      // Try to extract a phone from snippet
      const phoneMatch = snippet.match(/(?:\+?\d[\d\s().-]{6,}\d)/)
      const phone = phoneMatch ? phoneMatch[0].trim() : null
      const website = /^https?:\/\//i.test(href) && !/bing\.com/i.test(href) ? href : null
      businesses.push({
        name: title,
        address: snippet.slice(0, 120) || location,
        phone,
        website,
        rating: null,
        rating_count: null,
        category: query,
        google_maps: null,
        email: null,
        detected_language: null,
        site_text: null,
      })
    }
    if (!businesses.length) return { businesses: [], error: "no results parsed from Bing" }
    return { businesses }
  } catch (e) {
    return { businesses: [], error: `Bing search failed: ${String(e)}` }
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const EMAIL_NOISE = ["example.com", "example.org", "example.net", "example.edu", "example@", "sentry.", "wixpress", "yourdomain", "pec.it", "@pec.", "legalmail.", "telecompost.", "arubapec.", "postacert.", "certmail.", "noreply", "no-reply", "mailer-daemon"]

// ---------------------------------------------------------------------------
// Browser headers for crawling business websites (realistic browser).
// USER_AGENT stays for OSM/Nominatim/Photon/Overpass APIs per their policies.
// ---------------------------------------------------------------------------
export const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
}

// ---------------------------------------------------------------------------
// Email cleaning / filtering / prioritization helpers
// ---------------------------------------------------------------------------
const IMAGE_EXT_NOISE = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]

export function cleanAndFilterEmail(raw: string | null): string | null {
  if (!raw) return null
  let email = decodeURIComponent(raw).trim().toLowerCase().replace(/[.,;:)>]+$/, "")
  if (!EMAIL_PATTERN.test(email)) return null
  if (EMAIL_NOISE.some((noise) => email.includes(noise))) return null
  if (IMAGE_EXT_NOISE.some((ext) => email.endsWith(ext))) return null
  return email
}

const EMAIL_PRIORITY_1 = ["info@", "segreteria@", "contatti@", "contact@", "amministrazione@", "studio@", "accoglienza@", "ufficio@", "prenotazioni@"]
const WEBMAIL_DOMAINS = ["@gmail.com", "@libero.it", "@virgilio.it", "@alice.it", "@tiscali.it"]

function emailPriority(email: string): number {
  const lower = email.toLowerCase()
  if (EMAIL_PRIORITY_1.some((p) => lower.startsWith(p))) return 1
  if (WEBMAIL_DOMAINS.some((d) => lower.endsWith(d))) return 3
  return 2
}

export function extractEmailsFromHtml(html: string): string[] {
  const decoded = html
    .replace(/&#64;/gi, "@")
    .replace(/&#46;/gi, ".")
    .replace(/&amp;/gi, "&")
  const collected: string[] = []
  const seen = new Set<string>()
  const mailtoRegex = /mailto:\s*([^\s"'?#>]+)/gi
  let m: RegExpExecArray | null
  while ((m = mailtoRegex.exec(decoded)) !== null) {
    const cand = m[1]
    if (!seen.has(cand)) { seen.add(cand); collected.push(cand) }
  }
  const regexMatches = decoded.match(new RegExp(EMAIL_PATTERN.source, "gi")) ?? []
  for (const rm of regexMatches) {
    if (!seen.has(rm)) { seen.add(rm); collected.push(rm) }
  }
  const cleaned: string[] = []
  for (const c of collected) {
    const email = decodeURIComponent(c).trim().replace(/[.,;:)>]+$/, "").toLowerCase()
    if (!EMAIL_PATTERN.test(email)) continue
    if (EMAIL_NOISE.some((noise) => email.includes(noise))) continue
    if (IMAGE_EXT_NOISE.some((ext) => email.endsWith(ext))) continue
    cleaned.push(email)
  }
  const unique = [...new Set(cleaned)]
  unique.sort((a, b) => emailPriority(a) - emailPriority(b))
  return unique
}

// ---------------------------------------------------------------------------
// Photon (primary, stable)
// ---------------------------------------------------------------------------

function photonEndpoint(): string {
  return (process.env.PHOTON_URL || "https://photon.komoot.io/api/").replace(/\/?$/, "/")
}

function osmApiEndpoint(): string {
  return (process.env.OSM_API_URL || "https://api.openstreetmap.org/api/0.6").replace(/\/$/, "")
}

const IT_PROVINCE_MAP: Record<string, string> = {
  cr: "Cremona", lo: "Lodi", mi: "Milano", bg: "Bergamo", bs: "Brescia",
  pv: "Pavia", mb: "Monza", mn: "Mantova", to: "Torino", rm: "Roma",
  bo: "Bologna", fi: "Firenze", na: "Napoli", ve: "Venezia", va: "Varese",
  co: "Como", lc: "Lecco", so: "Sondrio", pc: "Piacenza", pr: "Parma",
  re: "Reggio Emilia", mo: "Modena", fe: "Ferrara", ra: "Ravenna",
  fc: "Forlì-Cesena", rn: "Rimini", bo2: "Bologna",
}
function isItalianLocation(location: string): boolean {
  const l = location.toLowerCase()
  if (l.includes("italy") || l.includes("italia")) return true
  const parts = l.split(",").map((p) => p.trim())
  if (parts.some((p) => IT_PROVINCE_MAP[p])) return true
  return false
}
function locationTokens(location: string): string[] {
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const low = p.toLowerCase()
    if (IT_PROVINCE_MAP[low]) out.push(IT_PROVINCE_MAP[low])
    else out.push(p)
  }
  if (isItalianLocation(location) && !out.some((t) => /italy|italia/i.test(t))) {
    out.push("Italy")
  }
  return out
}

function matchesArea(feature: any, tokens: string[]): boolean {
  const props = feature?.properties ?? {}
  const city = String(props.city ?? props.district ?? "").toLowerCase()
  const county = String(props.county ?? "").toLowerCase()
  const state = String(props.state ?? "").toLowerCase()
  return tokens.some((token) => {
    const t = token.toLowerCase()
    return city.includes(t) || county.includes(t) || state.includes(t)
  })
}

function osmRef(feature: any): { type: string; id: number } | null {
  const props = feature?.properties ?? {}
  const osmType = String(props.osm_type ?? "").toUpperCase()
  const osmId = Number(props.osm_id)
  if (!osmType || !Number.isFinite(osmId)) return null
  const map: Record<string, string> = { N: "node", W: "way", R: "relation" }
  const type = map[osmType]
  if (!type) return null
  return { type, id: osmId }
}

async function scoutPhoton(
  location: string,
  tags: string[][],
  tagSet: Set<string>,
  limit: number,
): Promise<{ candidates: Candidate[]; error?: string; areaLevel?: string }> {
  const tokens = locationTokens(location)
  // Use the raw query word instead of the tag value for the search term.
  const italian = isItalianLocation(location)
  const searchTerms = new Set<string>()
  for (const entry of CATEGORY_TAGS) {
    for (const matcher of entry.match) {
      if (!tags.some((t) => entry.tags.some((et) => et[0] === t[0] && et[1] === t[1]))) continue
      // On Italian locations, skip English synonyms: use only the first (Italian) matcher.
      if (italian && matcher !== entry.match[0]) continue
      searchTerms.add(matcher)
    }
  }
  // Fall back to the query itself if no matcher resolved.
  if (!searchTerms.size) searchTerms.add(locationTokens(location)[0] ?? "")

  const allFeatures: any[] = []
  const failures: string[] = []
  let answered = false
  for (const term of searchTerms) {
    const q = `${term} ${tokens[0]}`.trim()
    const endpoint = `${photonEndpoint()}?${new URLSearchParams({ q, limit: String(limit * 3) })}`
    try {
      const response = await fetchWithRetry(endpoint, { headers: { "User-Agent": USER_AGENT } }, PHOTON_TIMEOUT_MS)
      if (!response.ok) {
        failures.push(`Photon ${endpoint}: HTTP ${response.status}`)
        continue
      }
      const body = (await response.json()) as { features?: any[] }
      answered = true
      allFeatures.push(...(Array.isArray(body.features) ? body.features : []))
    } catch (error) {
      failures.push(`Photon ${endpoint}: ${String(error)}`)
    }
  }

  if (!answered && failures.length) {
    return { candidates: [], error: `Photon search failed: ${failures.join("; ")}` }
  }

  // Filter by area and by trade tags.
  // Area filters in expanding order: strict city → broader region/country → any.
  const areaFilters: { label: string; fn: (f: any) => boolean }[] = [
    { label: "city/area", fn: (f) => matchesArea(f, tokens) },
    { label: "region/country", fn: (f) => tokens.length > 1 ? matchesArea(f, [tokens[tokens.length - 1]]) : true },
  ]
  const seen = new Set<string>()
  const refs: { ref: { type: string; id: number }; feature: any }[] = []
  let foundAreaLevel: string | undefined
  for (const af of areaFilters) {
    if (refs.length >= limit) break
    const before = refs.length
    for (const feature of allFeatures) {
      const props = feature?.properties ?? {}
      const osmKey = String(props.osm_key ?? "")
      const osmValue = String(props.osm_value ?? "")
      if (!tagSet.has(`${osmKey}=${osmValue}`)) continue
      if (!af.fn(feature)) continue
      const ref = osmRef(feature)
      if (!ref) continue
      const key = `${ref.type}/${ref.id}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ ref, feature })
      if (refs.length >= limit * 2) break
    }
    if (refs.length > before && !foundAreaLevel) {
      foundAreaLevel = af.label
    }
  }

  // Enrich each ref through the OSM API.
  const candidates: Candidate[] = []
  for (const { ref, feature } of refs.slice(0, limit * 2)) {
    const props = feature?.properties ?? {}
    let tags: Record<string, string> = {}
    try {
      const response = await fetchWithRetry(
        `${osmApiEndpoint()}/${ref.type}/${ref.id}.json`,
        { headers: { "User-Agent": USER_AGENT } },
        OSM_API_TIMEOUT_MS,
      )
      if (response.ok) {
        const body = (await response.json()) as { elements?: { tags?: Record<string, string> }[] }
        tags = body.elements?.[0]?.tags ?? {}
      }
    } catch {
      // Enrichment is best-effort; fall back to Photon's own fields.
    }

    const name = tags.name || props.name || ""
    if (!name) continue
    const address = osmAddress(tags) || [props.street, props.housenumber, props.postcode, props.city].filter(Boolean).join(", ")
    const phone = tags.phone ?? tags["contact:phone"] ?? tags.mobile ?? tags["contact:mobile"] ?? null
    const website = tags.website ?? tags["contact:website"] ?? null
    const rawEmail = tags.email ?? tags["contact:email"] ?? null
    const email = cleanAndFilterEmail(rawEmail)
    const category = tags[props.osm_key] === props.osm_value ? props.osm_value : (tags.craft ?? tags.shop ?? tags.amenity ?? tags.office ?? props.osm_value ?? "")
    candidates.push({
      business: {
        name,
        address,
        phone,
        website,
        rating: null,
        rating_count: null,
        category,
        google_maps: null,
        email,
        detected_language: null,
        site_text: null,
      },
      source: "osm",
    })
    if (candidates.length >= limit * 2) break
  }

  if (!candidates.length) {
    return { candidates: [], error: failures.length ? failures.join("; ") : undefined }
  }
  return { candidates, areaLevel: foundAreaLevel }
}

// ---------------------------------------------------------------------------
// Overpass (fallback)
// ---------------------------------------------------------------------------

function overpassEndpoints(): string[] {
  const override = process.env.OVERPASS_URL?.trim()
  return override ? [override.replace(/\/$/, "")] : OVERPASS_ENDPOINTS
}

function overpassQuery(areaName: string, adminLevel: string, tags: string[][]): string {
  const escaped = areaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const filters = tags.map(([key, value]) => `nwr(area.a)["${key}"="${value}"];`).join("")
  return `[out:json][timeout:25];area["name"~"^${escaped}$",i]["boundary"="administrative"]["admin_level"="${adminLevel}"]->.a;(${filters});out center tags;`
}

function areaAttempts(location: string) {
  const tokens = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const attempts = [
    { name: tokens[0], level: "8" },
    { name: tokens[0], level: "6" },
  ]
  if (tokens[1]) attempts.push({ name: tokens[1], level: "6" })
  return attempts
}

async function overpassSearch(query: string): Promise<{
  elements: OverpassElement[]
  answered: boolean
  error?: string
}> {
  const failures: string[] = []
  let answered = false
  for (const url of overpassEndpoints()) {
    try {
      const response = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
          body: `data=${encodeURIComponent(query)}`,
        },
        OVERPASS_TIMEOUT_MS,
        2,
      )
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`)
        continue
      }
      const body = (await response.json()) as OverpassResponse
      const elements = Array.isArray(body.elements) ? body.elements : []
      if (body.remark && !elements.length) {
        failures.push(`${url}: ${body.remark}`)
        continue
      }
      return { elements, answered: true }
    } catch (error) {
      failures.push(`${url}: ${String(error)}`)
    }
  }
  return { elements: [], answered, error: failures.join("; ") }
}

async function scoutOsm(location: string, tags: string[][]): Promise<{ businesses: ScoutedBusiness[]; error?: string }> {
  const failures: string[] = []
  for (const attempt of areaAttempts(location)) {
    const result = await overpassSearch(overpassQuery(attempt.name, attempt.level, tags))
    if (result.error) failures.push(result.error)
    const businesses = result.elements
      .map((element) => toOsmBusiness(element, tags))
      .filter((business): business is ScoutedBusiness => business !== null)
    if (businesses.length) return { businesses }
    if (!result.answered) return { businesses: [], error: `Overpass search failed: ${failures.join("; ")}` }
  }
  return {
    businesses: [],
    error: failures.length ? `Overpass search failed: ${failures.join("; ")}` : undefined,
  }
}

function toOsmBusiness(element: OverpassElement, tags: string[][]): ScoutedBusiness | null {
  const found = element.tags
  if (!found?.name) return null
  return {
    name: found.name,
    address: osmAddress(found),
    phone: found.phone ?? found["contact:phone"] ?? null,
    website: found.website ?? found["contact:website"] ?? null,
    rating: null,
    rating_count: null,
    category: [...new Set(tags.filter(([key, value]) => found[key] === value).map((pair) => pair[1]))].join(", "),
    google_maps: null,
    email: cleanAndFilterEmail(found.email ?? found["contact:email"] ?? null),
    detected_language: null,
    site_text: null,
  }
}

function osmAddress(tags: Record<string, string>): string {
  if (tags["addr:full"]) return tags["addr:full"]
  return [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
    [tags["addr:postcode"], tags["addr:city"]].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ")
}

// ---------------------------------------------------------------------------
// Google Places (optional fallback)
// ---------------------------------------------------------------------------

const DEFAULT_PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText"

function placesEndpoint(): string {
  return (process.env.GOOGLE_PLACES_URL || DEFAULT_PLACES_ENDPOINT).replace(/\/$/, "")
}

async function googleSearch(
  location: string,
  query: string,
  key: string,
  size: number,
): Promise<{ businesses: ScoutedBusiness[]; error?: string }> {
  try {
    const response = await fetchWithRetry(
      placesEndpoint(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": [
            "places.displayName",
            "places.formattedAddress",
            "places.nationalPhoneNumber",
            "places.internationalPhoneNumber",
            "places.websiteUri",
            "places.rating",
            "places.userRatingCount",
            "places.primaryType",
            "places.primaryTypeDisplayName",
            "places.googleMapsUri",
          ].join(","),
        },
        body: JSON.stringify({ textQuery: `${query} in ${location}`, pageSize: size }),
      },
      GOOGLE_TIMEOUT_MS,
    )
    if (!response.ok) {
      return { businesses: [], error: `Places search failed: HTTP ${response.status}` }
    }
    const body = (await response.json()) as PlacesResponse
    const places = Array.isArray(body.places) ? body.places : []
    return { businesses: places.slice(0, size).map(toPlace) }
  } catch (error) {
    return { businesses: [], error: `Places search failed: ${String(error)}` }
  }
}

function toPlace(place: NonNullable<PlacesResponse["places"]>[number]): ScoutedBusiness {
  return {
    name: place.displayName?.text ?? "",
    address: place.formattedAddress ?? "",
    phone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    rating: typeof place.rating === "number" ? place.rating : null,
    rating_count: place.userRatingCount ?? null,
    category: place.primaryTypeDisplayName?.text ?? place.primaryType ?? "",
    google_maps: place.googleMapsUri ?? null,
    email: null,
    detected_language: null,
    site_text: null,
  }
}

// ---------------------------------------------------------------------------
// Merge and dedup on name/phone/website/address
// ---------------------------------------------------------------------------

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function dedupKeys(business: ScoutedBusiness): string[] {
  const phone = business.phone?.replace(/\D/g, "")
  const website = business.website
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
  const name = normalizeText(business.name)
  const address = normalizeText(business.address)
  return [
    phone ? `phone:${phone}` : "",
    website ? `web:${website}` : "",
    name && address ? `na:${name}|${address}` : "",
    business.email ? `email:${business.email.toLowerCase()}` : "",
  ].filter(Boolean)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(farmacia|studio|dott|dottore|dottoressa|ditta|snc|srl|spa|l|la|il|lo|gli|le|i)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function nameSimilar(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  if (Math.abs(na.length - nb.length) <= 4 && levenshtein(na, nb) <= 3) return true
  return false
}

function addressSimilar(a: string, b: string): boolean {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  // Same postcode is a strong signal even when street strings differ.
  const pa = (a.match(/\b\d{5}\b/) ?? [])[0]
  const pb = (b.match(/\b\d{5}\b/) ?? [])[0]
  if (pa && pa === pb) return true
  return false
}

function mergeDedup(candidates: Candidate[]): Merged[] {
  const merged: Merged[] = []
  const byKey = new Map<string, number>()
  for (const candidate of candidates) {
    const keys = dedupKeys(candidate.business)
    let hit = keys.map((key) => byKey.get(key)).find((index) => index !== undefined)
    if (hit === undefined) {
      // Fuzzy fallback: catch renamed/abbreviated duplicates that share no
      // exact phone/website/name+address key (e.g. OSM shell vs Google entry).
      hit = merged.findIndex((entry) => {
        const sameName = nameSimilar(entry.business.name, candidate.business.name)
        if (!sameName) return false
        if (addressSimilar(entry.business.address, candidate.business.address)) return true
        // No address on either side: still merge when names are very close.
        if (!entry.business.address && !candidate.business.address) return true
        return false
      })
      if (hit < 0) hit = undefined
    }
    if (hit === undefined) {
      merged.push({ business: { ...candidate.business }, sources: [candidate.source] })
      for (const key of keys) byKey.set(key, merged.length - 1)
      continue
    }
    merged[hit].business = fillBusiness(merged[hit].business, candidate.business)
    if (!merged[hit].sources.includes(candidate.source)) merged[hit].sources.push(candidate.source)
    for (const key of keys) byKey.set(key, hit)
  }
  return merged
}

function fillBusiness(base: ScoutedBusiness, extra: ScoutedBusiness): ScoutedBusiness {
  return {
    name: base.name || extra.name,
    address: base.address || extra.address,
    phone: base.phone ?? extra.phone,
    website: base.website ?? extra.website,
    rating: base.rating ?? extra.rating,
    rating_count: base.rating_count ?? extra.rating_count,
    category: base.category || extra.category,
    google_maps: base.google_maps ?? extra.google_maps,
    email: base.email ?? extra.email,
    pec: base.pec ?? extra.pec,
    vat: base.vat ?? extra.vat,
    socials: base.socials ?? extra.socials,
    detected_language: base.detected_language ?? extra.detected_language,
    site_text: base.site_text ?? extra.site_text,
    crawl_found_at: base.crawl_found_at ?? extra.crawl_found_at,
  }
}

// ---------------------------------------------------------------------------
// Tag mapping helpers
// ---------------------------------------------------------------------------

function tagsForQuery(query: string): string[][] {
  const normalized = normalizeText(query)
  const words = new Set(normalized.split(" "))
  const isClinicBusiness = /cliniche|clinics?|clinical|polyclinic|poliambulatori/i.test(normalized)
  let tags = CATEGORY_TAGS.flatMap((entry) =>
    entry.match.some((matcher) => {
      const word = normalizeText(matcher)
      return word.includes(" ") ? normalized.includes(word) : words.has(word)
    })
      ? entry.tags
      : [],
  )
  // For clinic-business queries, drop individual-doctor tags so we surface
  // actual clinic businesses, not lone practitioners.
  if (isClinicBusiness) {
    tags = tags.filter((t) => !(t[0] === "amenity" && t[1] === "doctors") && !(t[0] === "healthcare" && t[1] === "doctor"))
  }
  return tags
}

// ---------------------------------------------------------------------------
// HTML -> clean text
// ---------------------------------------------------------------------------
export function stripHtmlToText(html: string): string {
  let s = html
  s = s.replace(/<(script|style|noscript|svg|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  s = s.replace(/<[^>]+>/g, " ")
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#64;/gi, "@").replace(/&#46;/gi, ".").replace(/&#\d+;/g, " ")
  s = s.replace(/\s+/g, " ").trim()
  return s
}

export function inferLanguageFromUrl(website: string): "it" | "en" | null {
  try {
    const u = new URL(website.startsWith("http") ? website : `https://${website}`)
    if (u.hostname.endsWith(".it")) return "it"
  } catch {}
  return null
}

async function fetchPage(url: string, timeoutMs: number): Promise<string | null> {
  const tryFetch = async (u: string): Promise<string | null> => {
    const res = await fetch(u, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const ct = res.headers.get("content-type") || ""
    if (ct && !/html/i.test(ct)) return null
    return await res.text()
  }
  try {
    return await tryFetch(url)
  } catch {
    if (url.startsWith("https://")) {
      try {
        return await tryFetch(url.replace(/^https:\/\//, "http://"))
      } catch {
        return null
      }
    }
    return null
  }
}

export async function crawlBusinessSite(website: string): Promise<{ email: string | null; detected_language: "it" | "en" | null; site_text: string | null }> {
  const intel = await crawlWebsiteHumanWaterfall(website)
  return { email: intel.email, detected_language: intel.detected_language, site_text: intel.site_text }
}

// (re-appended block: constants, helpers, waterfall crawler, discoverEmail)

const PAGE_FETCH_TIMEOUT_MS = 8_000
const MAX_CRAWL_PAGES = 8

const CONTACT_LINK_RE =
  /contatt|contact|dove-siamo|come-raggiungerci|sedi|recapiti|prenota|scrivici|richiedi/i
const ABOUT_LINK_RE =
  /chi-siamo|about|struttura|azienda|studio|team|staff|storia|centro|clinica|policlinico/i
const LEGAL_LINK_RE =
  /privacy|informativa|cookie|note-legali|legal|dati-societari|trasparenza/i
const BINARY_EXT_RE =
  /\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|zip|rar|doc|docx|xls|xlsx|mp4|mp3|xml|css|js)$/i

const PEC_DOMAINS = [
  "pec.it",
  "@pec.",
  "legalmail.",
  "telecompost.",
  "arubapec.",
  "postacert.",
  "certmail.",
  "sicurezzapostale.",
]

const JUNK_EMAIL_TOKENS = [
  "example.",
  "example@",
  "sentry.",
  "wixpress",
  "yourdomain",
  "noreply",
  "no-reply",
  "mailer-daemon",
  "wordpress@",
  "webmaster@",
]

const PRIORITY_PREFIXES = [
  "segreteria@",
  "info@",
  "contatti@",
  "contact@",
  "accoglienza@",
  "amministrazione@",
  "prenotazioni@",
  "studio@",
  "ufficio@",
]

function decodeBasicEntities(html: string): string {
  return html
    .replace(/&#64;|&#x40;/gi, "@")
    .replace(/&#46;|&#x2e;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s*\[\s*at\s*\]\s*|\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*|\s*\(\s*dot\s*\)\s*/gi, ".")
}

function decodeCloudflareEmails(html: string): string[] {
  const found: string[] = []
  const cfMatches = html.matchAll(/data-cfemail=["']([0-9a-fA-F]+)["']/gi)
  for (const m of cfMatches) {
    const hex = m[1]
    if (hex.length < 4) continue
    const key = parseInt(hex.slice(0, 2), 16)
    let out = ""
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key)
    }
    if (out.includes("@")) found.push(out.toLowerCase())
  }
  return found
}

function rankEmail(email: string): number {
  if (PRIORITY_PREFIXES.some((p) => email.startsWith(p))) return 1
  if (/@(gmail|yahoo|hotmail|outlook|libero|virgilio|alice|tiscali|tin)\./i.test(email)) return 3
  return 2
}

function extractEmailsFromFragment(fragment: string): { ordinary: string | null; pec: string | null } {
  const decoded = decodeBasicEntities(fragment)
  const rawCandidates: string[] = [...decodeCloudflareEmails(fragment)]

  for (const m of decoded.matchAll(/mailto:\s*([^\s"'?#>]+)/gi)) {
    rawCandidates.push(m[1])
  }
  for (const m of decoded.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    rawCandidates.push(m[0])
  }

  const ordinarySet = new Set<string>()
  let pecFound: string | null = null

  for (const raw of rawCandidates) {
    let cleaned = raw
    try {
      cleaned = decodeURIComponent(raw)
    } catch {
      // keep raw if malformed URI encoding
    }
    cleaned = cleaned.trim().replace(/[.,;:)>\]"']+$/, "").toLowerCase()
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) continue
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(cleaned)) continue
    if (JUNK_EMAIL_TOKENS.some((noise) => cleaned.includes(noise))) continue

    if (PEC_DOMAINS.some((pec) => cleaned.includes(pec))) {
      if (!pecFound) pecFound = cleaned
      continue
    }
    ordinarySet.add(cleaned)
  }

  const sorted = [...ordinarySet].sort((a, b) => rankEmail(a) - rankEmail(b))
  return { ordinary: sorted[0] ?? null, pec: pecFound }
}

function extractFooterHtml(html: string): string {
  const footerTags = [...html.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer>/gi)].map((m) => m[1])
  if (footerTags.length) return footerTags.join("\n")

  const divFooters = [
    ...html.matchAll(
      /<div\b[^>]*(?:id|class)=["'][^"']*(?:footer|colophon|bottom-bar|pie-pagina)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    ),
  ].map((m) => m[1])
  if (divFooters.length) return divFooters.join("\n")

  return html.slice(Math.floor(html.length * 0.75))
}

function extractBodyWithoutFooter(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
}

function extractAddressFromFragment(fragment: string): string | null {
  const street = /"streetAddress"\s*:\s*"([^"]+)"/i.exec(fragment)?.[1]
  const postal = /"postalCode"\s*:\s*"([^"]+)"/i.exec(fragment)?.[1]
  const city = /"addressLocality"\s*:\s*"([^"]+)"/i.exec(fragment)?.[1]
  if (street && (postal || city)) {
    return [street, [postal, city].filter(Boolean).join(" ")].join(", ").trim()
  }

  const addrTag = /<address\b[^>]*>([\s\S]*?)<\/address>/i.exec(fragment)?.[1]
  if (addrTag) {
    const clean = stripTags(addrTag)
    if (clean.length >= 8 && clean.length <= 160) return clean
  }

  const text = stripTags(fragment)
  const itMatch =
    /\b(?:Via|Viale|Piazza|Piazzale|Corso|Strada|Vicolo|Largo|Localit[àa]|Frazione)\s+[A-ZÀ-Ú0-9][^,;|\n]{3,65}?\b\d{5}\b\s+[A-ZÀ-Ú][A-Za-zÀ-ú\s'()-]{2,35}/i.exec(
      text,
    )
  return itMatch ? itMatch[0].trim() : null
}

function extractPhoneFromFragment(fragment: string): string | null {
  const tel = /href=["']tel:\s*([^"']+)["']/i.exec(fragment)?.[1]
  if (tel) return tel.trim()
  const text = stripTags(fragment)
  const phone = /(?:\+39\s*)?(?:0\d{1,4}[\s./-]?\d{5,8}|3\d{2}[\s./-]?\d{6,7})/.exec(text)
  return phone ? phone[0].trim() : null
}

function extractVatFromFragment(fragment: string): string | null {
  const text = stripTags(fragment)
  const m = /(?:P\.?\s*IVA|Partita\s+IVA)\s*:?\s*(?:IT)?\s*(\d{11})\b/i.exec(text)
  return m ? m[1] : null
}

function extractSocialsFromFragment(fragment: string): string[] {
  const socials = new Set<string>()
  for (const m of fragment.matchAll(/href=["'](https?:\/\/(?:www\.)?(?:facebook|instagram|linkedin)\.com\/[^"'#?]+)["']/gi)) {
    socials.add(m[1].replace(/\/$/, ""))
  }
  return [...socials]
}

function htmlToCleanText(html: string): string {
  return stripTags(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " "),
  )
}

function detectLanguage(html: string, text: string, url: string): "it" | "en" | null {
  const htmlLang = /<html\b[^>]*\blang=["']([a-z]{2})/i.exec(html)?.[1]?.toLowerCase()
  if (htmlLang === "it") return "it"
  if (htmlLang === "en") return "en"

  const lower = text.toLowerCase()
  const itHits = ["chi siamo", "contatti", "servizi", "partita iva", "p.iva", "informativa", "dove siamo"].filter((w) =>
    lower.includes(w),
  ).length
  const enHits = ["about us", "contact us", "services", "privacy policy", "all rights reserved"].filter((w) =>
    lower.includes(w),
  ).length

  if (itHits > enHits) return "it"
  if (enHits > itHits) return "en"
  if (/\.it(?:\/|$)/i.test(url)) return "it"
  return null
}

interface InternalLink {
  url: string
  scoreText: string
}

function normalizeUrlKey(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ""
    const path = u.pathname.replace(/\/+$/, "") || "/"
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${path}${u.search}`
  } catch {
    return raw.toLowerCase()
  }
}

function extractInternalLinks(html: string, baseUrl: string): InternalLink[] {
  let root: URL
  try {
    root = new URL(baseUrl)
  } catch {
    return []
  }
  const rootHost = root.hostname.replace(/^www\./, "").toLowerCase()
  const links: InternalLink[] = []
  const seen = new Set<string>()

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawHref = m[1].trim()
    if (!rawHref || /^(mailto:|tel:|javascript:)/i.test(rawHref)) continue
    let resolved: URL
    try {
      resolved = new URL(rawHref, root.origin)
    } catch {
      continue
    }
    if (!/^https?:$/i.test(resolved.protocol)) continue
    if (resolved.hostname.replace(/^www\./, "").toLowerCase() !== rootHost) continue
    if (BINARY_EXT_RE.test(resolved.pathname)) continue

    resolved.hash = ""
    const key = normalizeUrlKey(resolved.toString())
    if (seen.has(key)) continue
    seen.add(key)

    const anchorText = stripTags(m[2])
    links.push({
      url: resolved.toString(),
      scoreText: `${resolved.pathname} ${anchorText}`,
    })
  }
  return links
}

async function fetchPageHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const contentType = res.headers.get("content-type") ?? ""
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null
    const html = (await res.text()).slice(0, 600_000)
    return { html, finalUrl: res.url || url }
  } catch {
    return null
  }
}

export async function crawlWebsiteHumanWaterfall(website: string): Promise<WebsiteIntel> {
  const intel: WebsiteIntel = {
    email: null,
    pec: null,
    address: null,
    phone: null,
    vat: null,
    socials: [],
    detected_language: /\.it(?:\/|$)/i.test(website) ? "it" : null,
    site_text: null,
    found_at_step: null,
  }

  const raw = website.trim()
  if (!raw) return intel
  const initialUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

  const visited = new Set<string>()
  const textChunks: string[] = []
  const socialSet = new Set<string>()
  let pagesFetched = 0

  const harvestFragment = (fragment: string, stepLabel: string): boolean => {
    const { ordinary, pec } = extractEmailsFromFragment(fragment)
    if (!intel.pec && pec) intel.pec = pec
    if (!intel.address) intel.address = extractAddressFromFragment(fragment)
    if (!intel.phone) intel.phone = extractPhoneFromFragment(fragment)
    if (!intel.vat) intel.vat = extractVatFromFragment(fragment)
    for (const s of extractSocialsFromFragment(fragment)) socialSet.add(s)

    if (!intel.email && ordinary) {
      intel.email = ordinary
      intel.found_at_step = stepLabel
      return true
    }
    return false
  }

  const fetchOnce = async (url: string): Promise<{ html: string; finalUrl: string } | null> => {
    const key = normalizeUrlKey(url)
    if (visited.has(key) || pagesFetched >= MAX_CRAWL_PAGES) return null
    visited.add(key)
    pagesFetched++
    const page = await fetchPageHtml(url)
    if (page) {
      visited.add(normalizeUrlKey(page.finalUrl))
      const clean = htmlToCleanText(page.html)
      if (clean) textChunks.push(clean.slice(0, 1_500))
    }
    return page
  }

  const finalize = (): WebsiteIntel => {
    intel.socials = [...socialSet]
    const mergedText = textChunks.join("\n\n").trim()
    intel.site_text = mergedText ? mergedText.slice(0, 4_000) : null
    return intel
  }

  let home = await fetchOnce(initialUrl)
  if (!home && initialUrl.startsWith("https://")) {
    home = await fetchOnce(initialUrl.replace(/^https:\/\//i, "http://"))
  }
  if (!home) return finalize()

  intel.detected_language = detectLanguage(home.html, htmlToCleanText(home.html), home.finalUrl) ?? intel.detected_language

  const homeFooter = extractFooterHtml(home.html)
  if (harvestFragment(homeFooter, "1:homepage_footer")) return finalize()

  if (harvestFragment(extractBodyWithoutFooter(home.html), "1b:homepage_body")) return finalize()

  const homeLinks = extractInternalLinks(home.html, home.finalUrl)
  const rootOrigin = new URL(home.finalUrl).origin

  const contactLinks = homeLinks.filter((l) => CONTACT_LINK_RE.test(l.scoreText))
  if (!contactLinks.length) {
    contactLinks.push({ url: `${rootOrigin}/contatti`, scoreText: "contatti" })
  }
  for (const link of contactLinks.slice(0, 2)) {
    const page = await fetchOnce(link.url)
    if (!page) continue
    if (harvestFragment(extractBodyWithoutFooter(page.html), "2:contacts_body")) return finalize()
    if (harvestFragment(extractFooterHtml(page.html), "3:contacts_footer")) return finalize()
  }

  const aboutLinks = homeLinks.filter((l) => ABOUT_LINK_RE.test(l.scoreText))
  if (!aboutLinks.length) {
    aboutLinks.push({ url: `${rootOrigin}/chi-siamo`, scoreText: "chi-siamo" })
  }
  for (const link of aboutLinks.slice(0, 2)) {
    const page = await fetchOnce(link.url)
    if (!page) continue
    if (harvestFragment(extractBodyWithoutFooter(page.html), "4:about_body")) return finalize()
    if (harvestFragment(extractFooterHtml(page.html), "5:about_footer")) return finalize()
  }

  const legalLinks = homeLinks.filter((l) => LEGAL_LINK_RE.test(l.scoreText))
  if (!legalLinks.length) {
    legalLinks.push({ url: `${rootOrigin}/privacy-policy`, scoreText: "privacy-policy" })
  }
  for (const link of legalLinks.slice(0, 2)) {
    const page = await fetchOnce(link.url)
    if (!page) continue
    if (harvestFragment(page.html, "6:legal_privacy")) return finalize()
  }

  for (const link of homeLinks) {
    if (pagesFetched >= MAX_CRAWL_PAGES) break
    const page = await fetchOnce(link.url)
    if (!page) continue
    if (harvestFragment(extractBodyWithoutFooter(page.html), `7:scout_body(${new URL(page.finalUrl).pathname})`)) {
      return finalize()
    }
    if (harvestFragment(extractFooterHtml(page.html), `7:scout_footer(${new URL(page.finalUrl).pathname})`)) {
      return finalize()
    }
  }

  return finalize()
}

export async function discoverEmail(website: string): Promise<string | null> {
  const intel = await crawlWebsiteHumanWaterfall(website)
  return intel.email
}
