import type { EmailCandidate, EmailRoutingBucket, OutreachRoute, WebsiteIntelV2 } from "./enrichment_types.js"

const EMAIL_VALID_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/
const ASSET_EXT_RE = /\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff|woff2|ttf|pdf|mp4|xml)$/i

export const PEC_DOMAIN_TOKENS = [
  "@pec.",
".pec.it",
"pec.it",
"postecert.it",
"postacert.",
"legalmail.",
"arubapec.",
"registerpec.",
"namirialpec.",
"sicurezzapostale.",
"telecompost.",
"certmail.",
"pec-legal.",
"cnfpec.",
"avvocatinapoli.legalmail.it",
"ordineavvocati",
"odcec",
]

const PEC_LOCAL_EXACT = new Set(["pec", "postacertificata", "posta-certificata", "certificata"])

const JUNK_OR_AGENCY_TOKENS = [
  "example.",
"example@",
"sentry.",
"wixpress",
"yourdomain",
"iubenda.",
"cookiebot.",
"complianz.",
"wordpress@",
"mailer-daemon",
"postmaster@",
"hostmaster@",
"root@",
"cpanel@",
"plesk@",
"webagency",
"realizzazionesiti",
"noreply",
"no-reply",
"donotreply",
"do-not-reply",
"mailer-daemon",
"postmaster",
"hostmaster",
"webmaster",
]

const BLOCKED_LEGAL_ADMIN_PREFIXES = [
  "privacy",
"dpo",
"rpd",
"gdpr",
"dataprotection",
"data-protection",
"protezionedati",
"protezione-dati",
"titolaretrattamento",
"admin",
"contabilita",
"fatture",
"fatturazione",
"billing",
"accounting",
"fornitori",
"acquisti",
"pagamenti",
"tesoreria",
"hr",
"risorseumane",
"curriculum",
"cv",
"jobs",
"careers",
"lavoraconnoi",
"selezione",
"reclami",
"segnalazioni",
"whistleblowing",
"odv",
"organismodivigilanza",
"compliance",
"ufficiolegale",
"ufficio.legale",
"legal",
"legale",
"abuse",
"security",
"noreply",
"no-reply",
"donotreply",
"do-not-reply",
"webmaster",
"it-support",
"helpdesk",
"ced",
]

const FRONT_DESK_PREFIXES = [
  "segreteria",
"accoglienza",
"reception",
"prenotazioni",
"prenota",
"appuntamenti",
"accettazione",
"cup",
"studio",
"clienti",
"pazienti",
"assistenza",
]

const GENERIC_INFO_PREFIXES = [
  "info",
"informazioni",
"contatti",
"contatto",
"contact",
"contacts",
"hello",
"ciao",
"commerciale",
"vendite",
"sales",
"preventivi",
"ufficio",
"sede",
"direzione",
"amministrazione",
]

export const FREE_WEBMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "libero.it",
  "virgilio.it",
  "alice.it",
  "tim.it",
  "tin.it",
  "tiscali.it",
  "hotmail.com",
  "hotmail.it",
  "outlook.com",
  "outlook.it",
  "live.com",
  "live.it",
  "yahoo.com",
  "yahoo.it",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "fastwebnet.it",
  "email.it",
  "inwind.it",
  "katamail.com",
])

export function normalizeRawEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
    let s = String(raw).trim()
    try {
      s = decodeURIComponent(s)
    } catch {
      // keep raw if malformed percent-encoding
    }
    s = s
    .replace(/^mailto:\s*/i, "")
    .split("?")[0]
    .split("#")[0]
    .trim()
    .replace(/^[<("'\s]+|[.,;:)>\]"'\s]+$/g, "")
    .toLowerCase()
    if (!EMAIL_VALID_RE.test(s)) return null
      if (ASSET_EXT_RE.test(s)) return null
        return s
}

function normalizeHostRoot(website?: string | null): string {
  if (!website) return ""
    try {
      const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`)
      return u.hostname.replace(/^www\./i, "").toLowerCase()
    } catch {
      return String(website).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase()
    }
}

function brandTokens(businessName?: string | null, websiteHost?: string): string[] {
  const stop = new Set([
    "studio", "clinica", "centro", "poliambulatorio", "ambulatorio", "medico", "odontoiatrico",
    "dentistico", "associato", "associati", "legale", "commercialista", "srl", "srls", "snc",
    "sas", "spa", "ditta", "impresa", "italia", "milano", "crema", "cremona", "lodi", "castelleone",
  ])
  const raw = `${businessName || ""} ${(websiteHost || "").split(".")[0] || ""}`
  .toLowerCase()
  .normalize("NFD")
  .replace(/\p{M}/gu, "")
  .split(/[^a-z0-9]+/)
  .filter((t) => t.length >= 4 && !stop.has(t))
  return [...new Set(raw)]
}

export function isPecEmail(email: string): boolean {
  const norm = normalizeRawEmail(email)
  if (!norm) return false
    const [local, domain] = norm.split("@")
    if (PEC_LOCAL_EXACT.has(local)) return true
      if (/^pec[._-]/.test(local) || /[._-]pec$/.test(local)) return true
        return PEC_DOMAIN_TOKENS.some((tok) => norm.includes(tok) || domain.includes(tok.replace(/^@/, "")))
}

function matchesBlockedPrefix(localPart: string): string | null {
  const normalizedLocal = localPart.replace(/[0-9]+$/g, "")
  for (const prefix of BLOCKED_LEGAL_ADMIN_PREFIXES) {
    if (
      normalizedLocal === prefix ||
      normalizedLocal.startsWith(`${prefix}.`) ||
      normalizedLocal.startsWith(`${prefix}_`) ||
      normalizedLocal.startsWith(`${prefix}-`)
    ) {
      return prefix
    }
  }
  return null
}

function looksLikeDirectPerson(localPart: string): boolean {
  if (/^(?:dott|dr|avv|ing|arch|rag|geom)[._-][a-z]{2,}/.test(localPart)) return true
    if (/^[a-z]{2,15}\.[a-z]{2,18}$/.test(localPart)) {
      const [a, b] = localPart.split(".")
      const nonPerson = new Set([
        ...BLOCKED_LEGAL_ADMIN_PREFIXES,
        ...FRONT_DESK_PREFIXES,
        ...GENERIC_INFO_PREFIXES,
        "ufficio", "servizio", "reparto", "area", "assistenza", "commerciale",
      ])
      if (!nonPerson.has(a) && !nonPerson.has(b)) return true
    }
    if (/^[a-z]\.[a-z]{3,18}$/.test(localPart)) return true
      if (localPart === "titolare") return true
        return false
}

export function classifyEmailCandidate(
  rawEmail: string,
  opts?: {
    website?: string | null
    businessName?: string | null
    foundOnPages?: string[]
    foundInLegalOnly?: boolean
  },
): EmailCandidate | null {
  const email = normalizeRawEmail(rawEmail)
  if (!email) return null

    const [local, domain] = email.split("@")
    const pages = opts?.foundOnPages ?? []
    const legalOnly = Boolean(opts?.foundInLegalOnly)

    if (JUNK_OR_AGENCY_TOKENS.some((t) => email.includes(t))) {
      return {
        email,
        bucket: "junk_or_agency",
        sendable: false,
        rank: 0,
        domain_relation: "third_party_external",
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: "junk_or_platform_address",
      }
    }

    const host = normalizeHostRoot(opts?.website)
    const tokens = brandTokens(opts?.businessName, host)
    let domainRelation: EmailCandidate["domain_relation"] = "same_domain"

    if (FREE_WEBMAIL_DOMAINS.has(domain)) {
      domainRelation = "free_webmail"
    } else if (host) {
      if (domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`)) {
        domainRelation = "same_domain"
      } else if (tokens.some((t) => domain.includes(t))) {
        domainRelation = "brand_match"
      } else {
        domainRelation = "third_party_external"
      }
    } else if (tokens.length > 0 && tokens.some((t) => domain.includes(t))) {
      domainRelation = "brand_match"
    }

    if (isPecEmail(email)) {
      return {
        email,
        bucket: "pec",
        sendable: false,
        rank: 0,
        domain_relation: domainRelation,
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: "certified_pec_inbox",
      }
    }

    const blockedHit = matchesBlockedPrefix(local)
    if (blockedHit) {
      return {
        email,
        bucket: "blocked_legal_admin",
        sendable: false,
        rank: 0,
        domain_relation: domainRelation,
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: `blocked_prefix:${blockedHit}`,
      }
    }

    // Quarantine external domain emails (e.g. external DPO lawyer or web agency in footer/privacy)
    if (host && domainRelation === "third_party_external") {
      return {
        email,
        bucket: legalOnly ? "blocked_legal_admin" : "junk_or_agency",
        sendable: false,
        rank: 0,
        domain_relation: "third_party_external",
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: legalOnly ? "external_domain_on_legal_page" : "external_third_party_domain",
      }
    }

    // Free webmail found solely on a privacy policy page without appearing on contact/home
    if (legalOnly && domainRelation === "free_webmail") {
      return {
        email,
        bucket: "blocked_legal_admin",
        sendable: false,
        rank: 0,
        domain_relation: domainRelation,
        found_on_pages: pages,
        found_in_legal_only: true,
        reason: "free_webmail_on_legal_page_only",
      }
    }

    if (domainRelation !== "free_webmail" && looksLikeDirectPerson(local)) {
      return {
        email,
        bucket: "direct_person",
        sendable: true,
        rank: legalOnly ? 72 : 100,
        domain_relation: domainRelation,
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: "named_person_or_principal",
      }
    }

    if (FRONT_DESK_PREFIXES.some((p) => local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}_`) || local.startsWith(`${p}-`))) {
      return {
        email,
        bucket: "front_desk",
        sendable: true,
        rank: domainRelation === "free_webmail" ? 65 : 88,
        domain_relation: domainRelation,
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: "front_desk_reception",
      }
    }

    if (domainRelation === "free_webmail") {
      return {
        email,
        bucket: "generic_info",
        sendable: true,
        rank: 55,
        domain_relation: "free_webmail",
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: "business_free_webmail",
      }
    }

    if (GENERIC_INFO_PREFIXES.some((p) => local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}_`) || local.startsWith(`${p}-`))) {
      return {
        email,
        bucket: "generic_info",
        sendable: true,
        rank: legalOnly ? 60 : 75,
        domain_relation: domainRelation,
        found_on_pages: pages,
        found_in_legal_only: legalOnly,
        reason: "general_business_inbox",
      }
    }

    return {
      email,
      bucket: "generic_info",
      sendable: true,
      rank: legalOnly ? 58 : 78,
      domain_relation: domainRelation,
      found_on_pages: pages,
      found_in_legal_only: legalOnly,
      reason: "domain_inbox",
    }
}

export function isSendableOutreachEmail(
  rawEmail: string | null | undefined,
  opts?: { website?: string | null; businessName?: string | null },
): boolean {
  if (!rawEmail) return false
    const c = classifyEmailCandidate(rawEmail, opts)
    return Boolean(c && c.sendable)
}

export function selectBestEmails(candidates: EmailCandidate[]): {
  bestSendable: EmailCandidate | null
  bestPec: EmailCandidate | null
  sortedAll: EmailCandidate[]
} {
  const byEmail = new Map<string, EmailCandidate>()
  for (const cand of candidates) {
    const existing = byEmail.get(cand.email)
    if (!existing) {
      byEmail.set(cand.email, { ...cand, found_on_pages: [...new Set(cand.found_on_pages)] })
      continue
    }
    const mergedPages = [...new Set([...existing.found_on_pages, ...cand.found_on_pages])]
    const legalOnly = existing.found_in_legal_only && cand.found_in_legal_only
    const pick = cand.rank > existing.rank ? cand : existing
    byEmail.set(cand.email, {
      ...pick,
      found_on_pages: mergedPages,
      found_in_legal_only: legalOnly,
      sendable: pick.sendable || (!legalOnly && existing.bucket === "blocked_legal_admin" && existing.reason === "free_webmail_on_legal_page_only"),
    })
  }
  const sortedAll = [...byEmail.values()].sort((a, b) => b.rank - a.rank)
  const bestSendable = sortedAll.find((c) => c.sendable) ?? null
  const bestPec = sortedAll.find((c) => c.bucket === "pec") ?? null
  return { bestSendable, bestPec, sortedAll }
}

export function determineOutreachRoute(
  intel: Pick<WebsiteIntelV2, "email_candidates" | "whatsapp" | "phones_found" | "forms">,
  fallbackClient?: { email?: string | null; phone?: string | null; website?: string | null; name?: string | null },
): OutreachRoute {
  const { bestSendable, bestPec } = selectBestEmails(intel.email_candidates || [])
  if (bestSendable) return "email_ready"
    if (fallbackClient?.email && isSendableOutreachEmail(fallbackClient.email, { website: fallbackClient.website, businessName: fallbackClient.name })) {
      return "email_ready"
    }
    if (intel.whatsapp?.detected) return "whatsapp_only"
      if ((intel.phones_found && intel.phones_found.length > 0) || (fallbackClient?.phone && fallbackClient.phone.trim())) {
        return "phone_only"
      }
      if (bestPec || (fallbackClient?.email && isPecEmail(fallbackClient.email))) return "pec_only"
        return "needs_manual_review"
}
