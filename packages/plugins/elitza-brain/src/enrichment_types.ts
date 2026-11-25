export type EmailRoutingBucket =
| "direct_person"
| "front_desk"
| "generic_info"
| "blocked_legal_admin"
| "pec"
| "junk_or_agency"

export type OutreachRoute =
| "email_ready"
| "pec_only"
| "phone_only"
| "whatsapp_only"
| "needs_manual_review"

export interface EmailCandidate {
  email: string
  bucket: EmailRoutingBucket
  sendable: boolean
  rank: number
  domain_relation: "same_domain" | "brand_match" | "free_webmail" | "third_party_external"
  found_on_pages: string[]
  found_in_legal_only: boolean
  reason: string
}

export interface FormFieldAudit {
  name: string
  type: string
  label: string | null
  required: boolean
}

export interface FormAudit {
  evidence_id: string
  page_url: string
  form_id_or_name: string | null
    plugin: string
    submit_label: string | null
    field_count: number
    fields: FormFieldAudit[]
    dropdown_options: string[]
    has_file_upload: boolean
    has_date_picker: boolean
    purpose: "contact" | "quote_request" | "appointment_request" | "document_submission"
}

export interface DecisionMakerClue {
  evidence_id: string
  full_name: string
  first_name: string | null
  role: string
  source_url: string
  snippet: string
  confidence: "high" | "medium"
}

export interface LocationClue {
  evidence_id: string
  raw_address: string
  city: string | null
  postal_code: string | null
  phone: string | null
  source_url: string
}

export interface PdfSignal {
  evidence_id: string
  url: string
  anchor_text: string
  doc_kind: "carta_dei_servizi" | "modulistica" | "tariffario_convenzioni" | "company_profile" | "other"
  bytes_read: number
  extracted_tags: string[]
  text_excerpt: string
}

export interface VideoSignal {
  evidence_id: string
  url: string
  provider: "youtube" | "vimeo" | "loom" | "wistia" | "html5" | "schema_video"
  title: string | null
  author: string | null
  short_description: string | null
  keywords: string[]
  captions_excerpt: string | null
  description_or_transcript_excerpt: string | null
  tier_used: 1 | 2 | 3
}

export interface PhoneAndFormScript {
  channel: "phone" | "whatsapp" | "contact_form"
  phone_opener: string
  written_message: string
}

export interface WebsiteIntelV2 {
  // Backward-compatible legacy WebsiteIntel fields:
  email: string | null
  pec: string | null
  address: string | null
  phone: string | null
  vat: string | null
  socials: string[]
  detected_language: "it" | "en" | null
  site_text: string | null
  found_at_step: string | null

  // v2 deterministic expansion:
  crawl_mode: "scout_fast" | "deep_audit"
  anti_bot_blocked: boolean
  pages_crawled: { url: string; bucket: string; title: string | null; chars: number }[]
  email_candidates: EmailCandidate[]
  phones_found: string[]
  whatsapp: { detected: boolean; phone_or_url: string | null; prefilled_text: string | null }
  addresses_found: LocationClue[]
  locations_count: number
  languages_detected: string[]
  channels_detected: ("email" | "phone" | "whatsapp" | "contact_form" | "online_booking" | "live_chat" | "pec")[]
  booking_widgets: { name: string; mode: "instant_slot" | "request_form" | "external_portal"; url_or_clue: string }[]
  chat_widgets: string[]
  cms_and_tech: string[]
  forms: FormAudit[]
    hours_snippets: { evidence_id: string; text: string; source_url: string }[]
    urgency_or_saturday_clues: string[]
    decision_maker_clues: DecisionMakerClue[]
    team_count_hint: {
      band: "1" | "2-5" | "6-10" | "11-25" | "26-50" | "50+" | "unknown"
      counted_profiles: number
      basis: string
    }
    schema_org_types: string[]
    pdf_signals: PdfSignal[]
    video_signals: VideoSignal[]
}

export interface OperationalSynthesisV2 {
  business_summary: string
  primary_vertical_noun:
  | "studio_medico"
  | "studio_dentistico"
  | "studio_professionale"
  | "impresa_artigiana"
  | "pmi_servizi"
  | "altro"
  evidence_confidence: "high" | "medium" | "low"
  pain_category: "lead_intake" | "crm_ops" | "customer_support" | "doc_automation" | "outbound"
  pain_points: { claim: string; evidence_ids: string[] }[]
  single_thread_focus:
  | "intake_triage"
  | "whatsapp_phone_booking"
  | "quotes_and_field_requests"
  | "documents_and_practices"
  touch1_question_candidate: {
    question_it_or_en: string
    bridge_it_or_en: string
    evidence_ids: string[]
  }
  phone_and_form_script?: PhoneAndFormScript | null
  offer_rationale: string
  next_action: string
}

export interface EnrichmentRecordV2 {
  schema_version: "2.0"
  enriched_at: string
  outreach_route: OutreachRoute
  best_email: EmailCandidate | null
  best_contact_person: { full_name: string; first_name: string | null; role: string; source_url: string } | null
  offer_track: string
  akli_recommended: boolean
  audit: Omit<WebsiteIntelV2, "site_text">
  synthesis: OperationalSynthesisV2
}
