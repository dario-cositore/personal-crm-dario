import { getClient, updateClient } from "./crm.js"
import type { Client } from "./crm.js"
import type { EnrichmentRecordV2 } from "./enrichment_types.js"

export type OfferTrack =
  | "it_local_audit_150"
  | "it_local_micro_490"
  | "it_pmi_diagnosi_400"
  | "it_pmi_track1_1500"
  | "it_pmi_track1_2500"
  | "it_pmi_track1_3500"
  | "en_discovery_0"
  | "en_track1_4000"
  | "akli_addon"
  | "track_2"

export interface TrackPricing {
  track: OfferTrack
  track_name: string
  currency: string
  setup_price: string
  recurring_price: string
  credit_rule?: string
  lines: string[]
}

const LOCAL_IT_TOWNS = [
  "castelleone", "crema", "cremona", "soresina", "lodi", "codogno",
  "pizzighettone", "offanengo", "pandino", "soncino", "orzinuovi", "casalpusterlengo",
]

const VALID_IT_TRACKS = new Set<OfferTrack>([
  "it_local_audit_150",
  "it_local_micro_490",
  "it_pmi_diagnosi_400",
  "it_pmi_track1_1500",
  "it_pmi_track1_2500",
  "it_pmi_track1_3500",
])

const VALID_EN_TRACKS = new Set<OfferTrack>(["en_discovery_0", "en_track1_4000"])

function parseV2(client: Client): EnrichmentRecordV2 | null {
  const raw = (client as any).enrichment_json
  if (!raw || typeof raw !== "string") return null
  try {
    const p = JSON.parse(raw)
    return p?.schema_version === "2.0" ? (p as EnrichmentRecordV2) : null
  } catch {
    return null
  }
}

function isIt(client: Client): boolean {
  return client.language === "it"
}

export function isLocalItTown(client: Client): boolean {
  const addr = (client.address || "").toLowerCase()
  return LOCAL_IT_TOWNS.some((t) => addr.includes(t))
}

function empNum(client: Client, v2: EnrichmentRecordV2 | null): number {
  const band = v2?.audit?.team_count_hint?.band
  if (band === "50+") return 55
  if (band === "26-50") return 30
  if (band === "11-25") return 15
  if (band === "6-10") return 8
  if (band === "2-5") return 3
  if (band === "1") return 1
  if (v2?.audit?.team_count_hint?.counted_profiles && v2.audit.team_count_hint.counted_profiles > 0) {
    return v2.audit.team_count_hint.counted_profiles
  }

  const emp = (client.employee_count || "").toLowerCase()
  if (!emp || emp === "unknown") return 0
  const cleaned = emp.replace(/\b\d+\s*(?:sedi|sede|filiali|ambulatori|uffici|locations)\b/gi, "")
  const rangeMatch = cleaned.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (rangeMatch) return Math.round((Number(rangeMatch[1]) + Number(rangeMatch[2])) / 2)
  const nums = [...cleaned.matchAll(/\d+/g)].map((m) => Number(m[0]))
  return nums.length ? Math.max(...nums) : 0
}

function combinedSignalText(client: Client, v2: EnrichmentRecordV2 | null): string {
  const parts = [
    client.notes || "",
    client.tech_stack || "",
    client.pain_category || "",
    v2?.synthesis?.business_summary || "",
    v2?.synthesis?.single_thread_focus || "",
    ...(v2?.audit?.cms_and_tech || []),
    ...(v2?.audit?.booking_widgets?.map((b) => b.name) || []),
  ]
  return parts.join(" ").toLowerCase()
}

function isMultiOfficeStructured(client: Client, v2: EnrichmentRecordV2 | null): boolean {
  if ((v2?.audit?.locations_count ?? 1) >= 2) return true
  const text = `${client.notes || ""} ${client.address || ""} ${client.company || ""}`.toLowerCase()
  return /\b(?:più\s+sedi|due\s+sedi|tre\s+sedi|filiali|multi.?office|studio\s+associato|soci\s+e\s+collaboratori)\b/.test(text)
}

function hasSingleWorkflowLeak(client: Client, v2: EnrichmentRecordV2 | null): boolean {
  if ((v2?.audit?.forms?.length ?? 0) > 0 && (v2?.audit?.booking_widgets?.length ?? 0) === 0) return true
  if (v2?.audit?.whatsapp?.detected) return true
  const text = combinedSignalText(client, v2)
  return /contact form|modulo contatt|richiedi preventiv|whatsapp|prenotazion|appuntament|segreteria|smistament|lead_intake|rallentament|urgenz/.test(
    text,
  )
}

function hasCrmOrMultiDeptIntake(client: Client, v2: EnrichmentRecordV2 | null): boolean {
  if ((v2?.audit?.locations_count ?? 1) >= 2 && (v2?.audit?.forms?.length ?? 0) > 0) return true
  if ((v2?.audit?.forms?.[0]?.dropdown_options?.length ?? 0) >= 3) return true
  const text = combinedSignalText(client, v2)
  return /crm|hubspot|pipedrive|salesforce|zoho|gestionale|miodottore|doctolib|alfadocs|teamsystem|zucchetti|crm_ops/.test(
    text,
  )
}

function hasDocumentOcr(client: Client, v2: EnrichmentRecordV2 | null): boolean {
  if (v2?.audit?.forms?.some((f) => f.has_file_upload || f.purpose === "document_submission")) return true
  if ((v2?.audit?.pdf_signals?.length ?? 0) >= 2 || v2?.synthesis?.single_thread_focus === "documents_and_practices") {
    return true
  }
  const text = combinedSignalText(client, v2)
  return /document|ocr|fattur|invoice|buste\s+paga|cedolin|contratt|pratiche|refert|modulistica|doc_automation/.test(text)
}

function detectsBrowserAiOrPii(client: Client): boolean {
  const text = `${client.notes || ""} ${client.tech_stack || ""} ${client.pain_category || ""} ${client.vertical || ""}`.toLowerCase()
  return /chatgpt|copilot|browser ai|pii|dati\s+sanitari|dati\s+sensibili|cartelle\s+cliniche/.test(text)
}

export function routeClientTrack(client: Client): { track: OfferTrack; pricing: TrackPricing } {
  const v2 = parseV2(client)
  const n = empNum(client, v2)
  const multiOffice = isMultiOfficeStructured(client, v2)
  const localTown = isLocalItTown(client)
  let track: OfferTrack

  if (isIt(client)) {
    const isStructuredSme = n >= 10 || (n === 0 && multiOffice && !localTown)
    if (isStructuredSme) {
      if (n <= 50) {
        if (hasDocumentOcr(client, v2)) track = "it_pmi_track1_3500"
        else if (hasCrmOrMultiDeptIntake(client, v2)) track = "it_pmi_track1_2500"
        else if (hasSingleWorkflowLeak(client, v2)) track = "it_pmi_track1_1500"
        else track = "it_pmi_diagnosi_400"
      } else {
        track = "it_pmi_diagnosi_400"
      }
    } else if (n === 0 && !localTown) {
      track = v2?.audit?.team_count_hint?.band === "1" ? "it_local_audit_150" : "it_pmi_diagnosi_400"
    } else {
      track = hasSingleWorkflowLeak(client, v2) ? "it_local_micro_490" : "it_local_audit_150"
    }
  } else {
    track = n > 0 && n < 20 && hasSingleWorkflowLeak(client, v2) ? "en_track1_4000" : "en_discovery_0"
  }

  const pricingMap: Record<OfferTrack, TrackPricing> = {
    it_local_audit_150: { track: "it_local_audit_150", track_name: "Audit Operativo Locale", currency: "EUR", setup_price: "€150", recurring_price: "-", lines: ["Audit Operativo Locale €150"] },
    it_local_micro_490: { track: "it_local_micro_490", track_name: "Assistente Operativo IA Locale", currency: "EUR", setup_price: "€490", recurring_price: "€49/mo", lines: ["Assistente Operativo IA Locale €490 setup + €49/mo Assistenza"] },
    it_pmi_diagnosi_400: { track: "it_pmi_diagnosi_400", track_name: "Diagnosi Operativa PMI", currency: "EUR", setup_price: "€400", recurring_price: "-", lines: ["Diagnosi Operativa PMI €400"] },
    it_pmi_track1_1500: { track: "it_pmi_track1_1500", track_name: "Agenti Operativi IA di Proprietà", currency: "EUR", setup_price: "€1.500", recurring_price: "€150-€250/mo", lines: ["Agenti Operativi IA di Proprietà €1.500 base"] },
    it_pmi_track1_2500: { track: "it_pmi_track1_2500", track_name: "Agenti Operativi IA di Proprietà (CRM & Intake)", currency: "EUR", setup_price: "€2.500", recurring_price: "€150-€250/mo", lines: ["Agenti Operativi IA di Proprietà €2.500 CRM & Intake"] },
    it_pmi_track1_3500: { track: "it_pmi_track1_3500", track_name: "Agenti Operativi IA di Proprietà (Documenti)", currency: "EUR", setup_price: "€3.500", recurring_price: "€150-€250/mo", lines: ["Agenti Operativi IA di Proprietà €3.500 documenti"] },
    en_discovery_0: { track: "en_discovery_0", track_name: "Discovery Call", currency: "USD", setup_price: "$0", recurring_price: "-", lines: ["Discovery Call $0", "Architecture & Readiness Review $1,500"] },
    en_track1_4000: { track: "en_track1_4000", track_name: "Owned AI Systems", currency: "USD", setup_price: "$4,000", recurring_price: "$450/mo", lines: ["Owned AI Systems $4,000 single / from $9,000 multi + $450/mo Care"] },
    akli_addon: { track: "akli_addon", track_name: "AKLI Team DLP", currency: "USD", setup_price: "$4/seat/mo", recurring_price: "$4/seat/mo", lines: ["AKLI Team DLP $4/seat/mo ($3 at 50+ seats)"] },
    track_2: { track: "track_2", track_name: "Mach 1 Tower", currency: "USD", setup_price: "$5,000", recurring_price: "$1,000/mo", lines: ["Mach 1 Tower (PAUSED)"] },
  }
  return { track, pricing: pricingMap[track] }
}

export function routeAndPersist(clientId: number): { track: OfferTrack; pricing: TrackPricing } {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const res = routeClientTrack(client)
  updateClient(clientId, { offer_track: res.track })
  return res
}

export function validateOfferSelection(
  client: Client,
  parsed: { offer_track?: string; offer_rationale?: string },
): { offer_track: OfferTrack; offer_rationale: string } {
  const fresh = getClient(client.id) ?? client
  const it = fresh.language === "it"
  const fallback = routeClientTrack(fresh).track
  const rawTrack = String(parsed?.offer_track || "").trim() as OfferTrack
  const rationale = (parsed?.offer_rationale || "").trim()

  let finalTrack: OfferTrack
  if (rawTrack === "track_2") {
    finalTrack = fallback
  } else if (it) {
    finalTrack = VALID_IT_TRACKS.has(rawTrack) ? rawTrack : fallback
  } else {
    finalTrack = VALID_EN_TRACKS.has(rawTrack) || rawTrack === "akli_addon" ? rawTrack : fallback
  }

  updateClient(fresh.id, { offer_track: finalTrack, offer_rationale: rationale })
  return { offer_track: finalTrack, offer_rationale: rationale }
}

export function akliRecommended(client: Client): boolean {
  return detectsBrowserAiOrPii(client)
}