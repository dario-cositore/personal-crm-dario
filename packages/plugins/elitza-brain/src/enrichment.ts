import fs from "node:fs"
import path from "node:path"
import { getClient, updateClient, logInteraction, addAsset } from "./crm.js"
import { AI_ENABLEMENT_HOME } from "./db.js"
import { crawlWebsiteAudit } from "./crawler_v2.js"
import {
  classifyEmailCandidate,
  determineOutreachRoute,
  FREE_WEBMAIL_DOMAINS,
  isPecEmail,
  isSendableOutreachEmail,
  selectBestEmails,
} from "./email_gate.js"
import { akliRecommended, routeClientTrack, validateOfferSelection } from "./routing.js"
import type {
  EnrichmentRecordV2,
  OperationalSynthesisV2,
  PhoneAndFormScript,
  WebsiteIntelV2,
} from "./enrichment_types.js"

const SOCIAL_RE: Record<string, RegExp> = {
  linkedin: /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s"'<>]+/i,
  twitter: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/i,
  facebook: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/[^\s"'<>]+/i,
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s"'<>]+/i,
}

export function normalizeItalianCaseSensitiveIA(text: string): string {
  return text.replace(/\b(?:AI|A\.I\.)/g, "IA")
}

export function extractEmails(text: string, website?: string | null, businessName?: string | null): string[] {
  const raw = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  const valid = raw
    .map((r) => classifyEmailCandidate(r, { website, businessName }))
    .filter((c): c is NonNullable<typeof c> => Boolean(c && c.sendable))
  return selectBestEmails(valid).sortedAll.map((c) => c.email)
}

export function resolveClientLanguage(
  client: any,
  website: string | null,
  htmlLang?: string | null,
  siteText?: string | null,
): "it" | "en" {
  const IT_PROVINCES = ["CR", "MI", "BG", "BS", "LO", "PV", "MB", "VA", "CO", "LC", "SO", "MN", "TO", "RM", "BO", "FI", "NA", "VE", "VR", "PD", "PR", "PC", "MO", "RE"]
  const address = String(client?.address || "").toLowerCase()
  const w = (website || "").toLowerCase()
  if (htmlLang && /^it/i.test(htmlLang)) return "it"
  const text = (siteText || "").toLowerCase()
  const itHits = ["chi siamo", "contatti", "servizi", "partita iva", "p.iva", "informativa", "dove siamo", "segreteria"].filter((x) => text.includes(x)).length
  const enHits = ["about us", "contact us", "services", "privacy policy", "all rights reserved"].filter((x) => text.includes(x)).length
  if (itHits > enHits) return "it"
  if (w.endsWith(".it") || w.includes(".it/")) return "it"
  if (address.includes("italy") || address.includes("italia")) return "it"
  if (IT_PROVINCES.some((p) => new RegExp("\\b" + p + "\\b").test((client?.address || "").toUpperCase()))) return "it"
  if (/\b(?:via|viale|piazza|corso|strada|vicolo)\b/i.test(client?.address || "") && /\b\d{5}\b/.test(client?.address || "")) return "it"
  if (typeof client?.phone === "string" && /^(?:\+39|0\d{1,3})/.test(client.phone.trim())) return "it"
  if (client?.language === "it") return "it"
  return "en"
}

function extractSocialMap(urls: string[]): { linkedin?: string; twitter?: string; facebook?: string; instagram?: string } {
  const out: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string } = {}
  for (const raw of urls) {
    for (const [k, re] of Object.entries(SOCIAL_RE)) {
      if (!out[k as keyof typeof out] && re.test(raw)) {
        const clean = raw.split("?")[0].split("#")[0].replace(/\/$/, "")
        out[k as keyof typeof out] = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
      }
    }
  }
  return out
}

function buildDeterministicEvidencePacket(intel: WebsiteIntelV2): string {
  const lines: string[] = []
  lines.push(`Pages crawled (${intel.pages_crawled.length}): ${intel.pages_crawled.map((p) => `${p.bucket}:${p.url}`).join(", ") || "none"}`)
  lines.push(`Locations (${intel.locations_count}): ${intel.addresses_found.map((l) => `[${l.evidence_id}] ${l.raw_address}`).join(" | ") || "none"}`)
  lines.push(`Channels detected: ${intel.channels_detected.join(", ") || "none"}`)
  if (intel.whatsapp.detected) lines.push(`[widget:whatsapp] WhatsApp active (${intel.whatsapp.phone_or_url})`)
  if (intel.booking_widgets.length) {
    lines.push(`Booking widgets: ${intel.booking_widgets.map((b, i) => `[booking:${i}] ${b.name} (${b.mode})`).join(", ")}`)
  }
  if (intel.chat_widgets.length) lines.push(`Live chat: ${intel.chat_widgets.join(", ")}`)
  if (intel.cms_and_tech.length) lines.push(`Tech/CMS: ${intel.cms_and_tech.join(", ")}`)
  if (intel.forms.length) {
    for (const f of intel.forms) {
      lines.push(
        `[${f.evidence_id}] ${f.purpose} on ${f.page_url} (${f.plugin}, ${f.field_count} fields${f.has_file_upload ? ", file-upload" : ""}${f.has_date_picker ? ", date-picker" : ""}${f.dropdown_options.length ? `, options: ${f.dropdown_options.join(" / ")}` : ""})`,
      )
    }
  }
  if (intel.hours_snippets.length) {
    for (const h of intel.hours_snippets) lines.push(`[${h.evidence_id}] ${h.text}`)
  }
  if (intel.urgency_or_saturday_clues.length) {
    lines.push(`Urgency clues: ${intel.urgency_or_saturday_clues.join(" | ")}`)
  }
  if (intel.decision_maker_clues.length) {
    lines.push(
      `Decision-makers/staff (${intel.team_count_hint.band}): ${intel.decision_maker_clues.slice(0, 6).map((d) => `[${d.evidence_id}] ${d.full_name} (${d.role})`).join("; ")}`,
    )
  }
  for (const p of intel.pdf_signals) {
    lines.push(`[${p.evidence_id}] PDF ${p.doc_kind} "${p.anchor_text}" tags=[${p.extracted_tags.join(",")}] excerpt: ${p.text_excerpt.slice(0, 350)}`)
  }
  for (const v of intel.video_signals) {
    lines.push(`[${v.evidence_id}] Video (${v.provider}, tier ${v.tier_used}) title="${v.title || ""}" ${v.description_or_transcript_excerpt?.slice(0, 350) || ""}`)
  }
  return lines.join("\n")
}

function buildFallbackPhoneAndFormScript(
  lang: "it" | "en",
  channel: "phone" | "whatsapp" | "contact_form",
  question: string,
  bridge: string,
): PhoneAndFormScript {
  if (lang === "it") {
    const cleanQ = normalizeItalianCaseSensitiveIA(question.replace(/^Buongiorno,?\s*(?:una domanda diretta:\s*)?/i, "").trim())
    const cleanB = normalizeItalianCaseSensitiveIA(bridge.trim())
    return {
      channel,
      phone_opener: `Buongiorno, sono Dario Cositore, una domanda veloce per non rubarvi tempo: ${cleanQ} ${cleanB}`,
      written_message: `Buongiorno, una domanda diretta: ${cleanQ} ${cleanB} Magari avete già tutto sotto controllo; se così non fosse, vi va di sentirci 15 minuti questa settimana per capire se ha senso approfondire? - Dario Cositore (dariocositore.com/it)`,
    }
  }
  return {
    channel,
    phone_opener: `Hi, this is Dario Cositore with a quick operational question: ${question} ${bridge}`,
    written_message: `Hi, quick question: ${question} ${bridge} You might already have this dialed in, but if not, open to a quick 15-minute chat this week? - Dario Cositore`,
  }
}

function sanitizeScriptZeroPriceAndIA(script: PhoneAndFormScript, lang: "it" | "en"): PhoneAndFormScript {
  const stripPrices = (s: string) =>
    s
      .replace(/[€$]\s*\d[\d.,]*(?:\s*\/\s*(?:mese|mo|month))?/gi, "")
      .replace(/\b(?:EUR|USD)\s*\d[\d.,]*/gi, "")
      .replace(/—|–/g, ",")
      .replace(/\s{2,}/g, " ")
      .trim()
  const fix = (s: string) => (lang === "it" ? normalizeItalianCaseSensitiveIA(stripPrices(s)) : stripPrices(s))
  return {
    channel: script.channel,
    phone_opener: fix(script.phone_opener),
    written_message: fix(script.written_message),
  }
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
  outreach_route?: string
  pain_category?: string
  evidence_confidence?: string
  enrichment_v2?: EnrichmentRecordV2
  error?: string
}

export async function enrichClient(
  clientId: number,
  opts?: { onProgress?: (line: string) => void; transcribeVideoAudio?: boolean },
): Promise<EnrichmentResult> {
  const log = (line: string) => {
    try { opts?.onProgress?.(line) } catch {}
  }
  let client = getClient(clientId)
  if (!client) {
    return {
      ok: false, client_id: clientId, website: null, emails: [], phones: [], socials: {},
      diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "",
      tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "",
      error: `No client with id ${clientId}.`,
    }
  }

  log(`Starting v2 deep_audit enrichment for "${client.name}" (#${clientId})…`)

  const existingEmail = (client.email || "").trim()
  let preservedPec: string | null = (client as any).pec_email || null
  if (existingEmail) {
    if (isPecEmail(existingEmail)) {
      preservedPec = preservedPec || existingEmail.toLowerCase()
      log(`Quarantining PEC address on file (${existingEmail}) -> pec_email; clearing cold email slot.`)
      client = updateClient(clientId, { email: null, pec_email: preservedPec }) ?? client
    } else if (!isSendableOutreachEmail(existingEmail, { website: client.website, businessName: client.name })) {
      log(`Quarantining blocked/legal/admin email on file (${existingEmail}); clearing cold email slot.`)
      client = updateClient(clientId, { email: null }) ?? client
    }
  }

  let website = client.website?.trim() || null
  if (website) {
    try {
      const dom = new URL(website.includes("://") ? website : `https://${website}`).hostname.replace(/^www\./i, "").toLowerCase()
      if (FREE_WEBMAIL_DOMAINS.has(dom) || isPecEmail(`test@${dom}`)) website = null
    } catch {}
  }
  if (!website && client.email && client.email.includes("@")) {
    const dom = client.email.split("@")[1].toLowerCase()
    if (dom && !FREE_WEBMAIL_DOMAINS.has(dom) && !isPecEmail(client.email)) {
      website = dom
      log(`Using business email domain "${dom}" as website.`)
    }
  }
  if (!website && (client.address || client.name)) {
    try {
      const { scoutBusinesses } = await import("./scouting.js")
      const res: any = await Promise.race([
        scoutBusinesses(client.address || client.name, client.name || client.vertical || "studio", 6),
        new Promise((_, rej) => setTimeout(() => rej(new Error("scout timeout")), 6000)),
      ])
      const lower = client.name.toLowerCase()
      const hit = (res?.businesses || []).find((b: any) => {
        const bn = String(b?.name || "").toLowerCase()
        return bn === lower || bn.includes(lower) || lower.includes(bn)
      })
      if (hit?.website) {
        website = hit.website
        log(`Discovered website via scout match: ${website}`)
      }
    } catch {}
  }

  const intel = website
    ? await crawlWebsiteAudit(website, {
        mode: "deep_audit",
        businessName: client.name,
        transcribeVideoAudio: Boolean(opts?.transcribeVideoAudio),
        onProgress: log,
      })
    : await crawlWebsiteAudit("", { mode: "deep_audit" })

  const searchSnippets: string[] = []
  if (!intel.site_text || intel.site_text.length < 300 || intel.anti_bot_blocked) {
    const city = (client.address || "").split(",")[0].trim()
    const queries = [`"${client.name}" ${city}`.trim(), website ? `"${website}" contatti` : ""].filter((q) => q.length > 5).slice(0, 2)
    for (const q of queries) {
      try {
        const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ElitzaAudit/2.0)" },
          signal: AbortSignal.timeout(6000),
        })
        if (r.ok) {
          const html = await r.text()
          const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
            .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 5)
          searchSnippets.push(...snips)
        }
      } catch {}
    }
  }

  const hasAnySignal = Boolean(
    (intel.site_text && intel.site_text.length >= 80) ||
      searchSnippets.length > 0 ||
      intel.forms.length > 0 ||
      intel.phones_found.length > 0 ||
      client.phone,
  )
  if (!hasAnySignal) {
    updateClient(clientId, { status: "not_enough_info", outreach_route: "needs_manual_review" })
    return {
      ok: false, client_id: clientId, website, emails: [], phones: [], socials: {},
      diagnosis: "", proposal: "", price: "", risk_level: "high", risk_score: 70,
      risk_notes: "No verifiable public signal found.", tech_stack: "unknown",
      revenue_estimate: "unknown", employee_count: "unknown",
      next_action: "Add website or verify contact details manually.",      outreach_route: "needs_manual_review", error: "No public information found.",
    }
  }

  const lang = resolveClientLanguage(client, website, intel.detected_language, intel.site_text)
  if (client.language !== lang) {
    client = updateClient(clientId, { language: lang }) ?? { ...client, language: lang }
  }

  const { bestSendable, bestPec } = selectBestEmails(intel.email_candidates)
  const sendableEmails = intel.email_candidates.filter((c) => c.sendable).map((c) => c.email)
  const outreachRoute = determineOutreachRoute(intel, client)
  const socials = extractSocialMap(intel.socials)
  const needsPhoneFormScript = outreachRoute === "phone_only" || outreachRoute === "whatsapp_only"

  const parsedSyn: Partial<OperationalSynthesisV2> = {}

  const defaultQ =
    lang === "it"
      ? "quando arriva una nuova richiesta dal sito o via telefono, chi la smista e prepara la prima risposta in segreteria?"
      : "when a new inquiry lands from your website or phone, who triages it and prepares the first reply?"
  const defaultB =
    lang === "it"
      ? "Te lo chiedo perché nelle realtà strutturate è quasi sempre il passaggio manuale tra richieste, agenda e risposte a rallentare il lavoro quotidiano."
      : "I ask because in busy practices, manual handoffs between incoming inquiries, calendars, and replies are usually what slow down response times."

  const rawQ = String(parsedSyn.touch1_question_candidate?.question_it_or_en || defaultQ).trim()
  const rawB = String(parsedSyn.touch1_question_candidate?.bridge_it_or_en || defaultB).trim()

  const fallbackChannel: "phone" | "whatsapp" | "contact_form" =
    outreachRoute === "whatsapp_only" ? "whatsapp" : intel.forms.length > 0 ? "contact_form" : "phone"

  let phoneScript: PhoneAndFormScript | null = null
  if (needsPhoneFormScript) {
    const cand = parsedSyn.phone_and_form_script
    const baseScript =
      cand && cand.phone_opener && cand.written_message
        ? {
            channel: cand.channel || fallbackChannel,
            phone_opener: String(cand.phone_opener),
            written_message: String(cand.written_message),
          }
        : buildFallbackPhoneAndFormScript(lang, fallbackChannel, rawQ, rawB)
    phoneScript = sanitizeScriptZeroPriceAndIA(baseScript, lang)
  }

  const synthesis: OperationalSynthesisV2 = {
    business_summary:
      lang === "it"
        ? normalizeItalianCaseSensitiveIA(String(parsedSyn.business_summary || `${client.name} opera a ${client.address || "livello locale"}.`))
        : String(parsedSyn.business_summary || `${client.name} operates in ${client.address || "its local market"}.`),
    primary_vertical_noun: (parsedSyn.primary_vertical_noun as any) || "altro",
    evidence_confidence:
      intel.anti_bot_blocked || (intel.site_text?.length ?? 0) < 300
        ? "low"
        : ((parsedSyn.evidence_confidence as any) || "medium"),
    pain_category: (parsedSyn.pain_category as any) || "lead_intake",
    pain_points: Array.isArray(parsedSyn.pain_points) ? parsedSyn.pain_points : [],
    single_thread_focus: (parsedSyn.single_thread_focus as any) || "intake_triage",
    touch1_question_candidate: {
      question_it_or_en: lang === "it" ? normalizeItalianCaseSensitiveIA(rawQ) : rawQ,
      bridge_it_or_en: lang === "it" ? normalizeItalianCaseSensitiveIA(rawB) : rawB,
      evidence_ids: parsedSyn.touch1_question_candidate?.evidence_ids || [],
    },
    phone_and_form_script: phoneScript,
    offer_rationale: String(parsedSyn.offer_rationale || ""),
    next_action: String(parsedSyn.next_action || "Review v2 audit and approve outreach."),
  }

  const bestDm =
    intel.decision_maker_clues.find((d) => d.confidence === "high" && d.first_name) ||
    intel.decision_maker_clues.find((d) => d.confidence === "high") ||
    null

  const { site_text: _omittedText, ...compactAudit } = intel
  const now = new Date().toISOString()

  const recordV2: EnrichmentRecordV2 = {
    schema_version: "2.0",
    enriched_at: now,
    outreach_route: outreachRoute,
    best_email: bestSendable,
    best_contact_person: bestDm
      ? { full_name: bestDm.full_name, first_name: bestDm.first_name, role: bestDm.role, source_url: bestDm.source_url }
      : null,
    offer_track: "",
    akli_recommended: akliRecommended(client),
    audit: compactAudit,
    synthesis,
  }

  const techSummary =
    [...intel.cms_and_tech, ...intel.booking_widgets.map((b) => b.name), ...intel.chat_widgets].join(", ") || "unknown"
  const empSummary =
    client.employee_count && client.employee_count !== "unknown"
      ? client.employee_count
      : intel.team_count_hint.band

  const preservedPrefix =
    client.notes && client.notes.includes("[SCOUT Y")
      ? client.notes.split("\n\nOutreach route:")[0].trim() + "\n\n"
      : ""
  const painBullets = synthesis.pain_points.map((p) => `- ${p.claim} [${p.evidence_ids.join(", ")}]`).join("\n")
  const scriptBlock = phoneScript
    ? `\n\nPhone Opener (${phoneScript.channel}):\n${phoneScript.phone_opener}\n\nForm/WhatsApp Message:\n${phoneScript.written_message}`
    : ""
  const formattedNotes = `${preservedPrefix}Outreach route: ${outreachRoute} | Confidence: ${synthesis.evidence_confidence}\n\n${synthesis.business_summary}${painBullets ? `\n\nOperational friction:\n${painBullets}` : ""}${scriptBlock}`

  const { firstConfiguredStage } = await import("./crm.js")
  const first = firstConfiguredStage()
  const moveToEnriched = !client.status || client.status === first || client.status === "scouted" || client.status === "new"

  client =
    updateClient(clientId, {
      ...(moveToEnriched ? { status: "enriched" } : {}),
      ...(website && !client.website ? { website } : {}),
      ...(bestSendable && !client.email ? { email: bestSendable.email } : {}),
      ...(bestPec || preservedPec ? { pec_email: bestPec?.email || preservedPec } : {}),
      ...(intel.phone && !client.phone ? { phone: intel.phone } : {}),
      ...(intel.address && !client.address ? { address: intel.address } : {}),
      ...(bestDm ? { contact_name: bestDm.full_name } : {}),
      language: lang,
      outreach_route: outreachRoute,
      notes: formattedNotes,
      tech_stack: techSummary,
      employee_count: empSummary,
      pain_category: synthesis.pain_category,
      next_action: synthesis.next_action,
      linkedin: socials.linkedin ?? client.linkedin ?? null,
      twitter: socials.twitter ?? client.twitter ?? null,
      facebook: socials.facebook ?? client.facebook ?? null,
      instagram: socials.instagram ?? client.instagram ?? null,
      enrichment_version: "2.0",
      enriched_at: now,
      enrichment_json: JSON.stringify(recordV2),
    }) ?? client

  const routed = routeClientTrack(client)
  const validatedOffer = validateOfferSelection(client, {
    offer_track: routed.track,
    offer_rationale: synthesis.offer_rationale,
  })
  recordV2.offer_track = validatedOffer.offer_track

  const riskLevel = outreachRoute === "email_ready" && synthesis.evidence_confidence !== "low" ? "low" : "medium"
  const riskScore = riskLevel === "low" ? 20 : 50
  const riskNotes = `Pages audited: ${intel.pages_crawled.length}; forms: ${intel.forms.length}; route: ${outreachRoute}.`

  updateClient(clientId, {
    offer_track: validatedOffer.offer_track,
    offer_rationale: validatedOffer.offer_rationale,
    risk_level: riskLevel,
    risk_score: riskScore,
    risk_notes: riskNotes,
    enrichment_json: JSON.stringify(recordV2),
  })

  try {
    const stamp = now.slice(0, 10)
    const dir = path.join(AI_ENABLEMENT_HOME, "pipeline", stamp)
    fs.mkdirSync(dir, { recursive: true })
    const diagPath = path.join(dir, `C${clientId}-diagnosis.md`)
    const propPath = path.join(dir, `C${clientId}-proposal.md`)
    const corpusPath = path.join(dir, `C${clientId}-enrichment-v2.json`)
    fs.writeFileSync(diagPath, `# Diagnosis — ${client.name}\n\n${formattedNotes}\n`)
    fs.writeFileSync(
      propPath,
      `# Proposal — ${client.name}\n\nTrack: ${routed.pricing.track_name} (${routed.pricing.setup_price})\nRationale: ${validatedOffer.offer_rationale}\n`,
    )
    fs.writeFileSync(corpusPath, JSON.stringify({ record: recordV2, raw_site_text: intel.site_text }, null, 2))
    addAsset(clientId, { kind: "diagnosis", name: `Diagnosis ${stamp}`, path: diagPath, status: "draft" })
    addAsset(clientId, { kind: "proposal", name: `Proposal ${stamp}`, path: propPath, status: "draft" })
    addAsset(clientId, { kind: "enrichment_v2", name: `Audit v2 ${stamp}`, path: corpusPath, status: "completed" })
    logInteraction(clientId, {
      kind: "enrichment",
      direction: "note",
      channel: "web",
      status: "completed",
      subject: `enrichment v2: ${client.name}`,
      body: JSON.stringify(recordV2, null, 2),
      occurred_at: now,
    })
  } catch {}

  return {
    ok: true,
    client_id: clientId,
    website: website || intel.pages_crawled[0]?.url || null,
    emails: sendableEmails,
    phones: intel.phones_found,
    socials,
    diagnosis: formattedNotes,
    proposal: `${routed.pricing.track_name} — ${routed.pricing.setup_price}`,
    price: routed.pricing.setup_price,
    risk_level: riskLevel,
    risk_score: riskScore,
    risk_notes: riskNotes,
    tech_stack: techSummary,
    revenue_estimate: "unknown",
    employee_count: empSummary,
    next_action: synthesis.next_action,
    outreach_route: outreachRoute,
    pain_category: synthesis.pain_category,
    evidence_confidence: synthesis.evidence_confidence,
    enrichment_v2: recordV2,
  }
}

export async function enrichBatch(
  clientIds: number[],
  opts?: { concurrency?: number; onProgress?: (line: string) => void },
): Promise<any[]> {
  const conc = opts?.concurrency ?? 4
  const results: any[] = new Array(clientIds.length)
  let idx = 0
  async function worker() {
    while (true) {
      const i = idx++
      if (i >= clientIds.length) break
      const id = clientIds[i]
      let attempt = 0
      while (attempt < 3) {
        try {
          results[i] = await enrichClient(id, { onProgress: opts?.onProgress, transcribeVideoAudio: false })
          break
        } catch (e) {
          attempt++
          if (attempt >= 3) {
            results[i] = { ok: false, client_id: id, error: String(e) }
            break
          }
          await new Promise((res) => setTimeout(res, 300 * Math.pow(2, attempt)))
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, clientIds.length) }, () => worker()))
  return results
}