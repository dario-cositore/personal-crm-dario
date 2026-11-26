import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-v2-test-"))
process.env.AI_ENABLEMENT_HOME = tmpHome
process.env.ELITZA_CRM_DB = path.join(tmpHome, "crm-test.db")
process.env.RESEND_API_KEY = "re_test_key"
process.env.RESEND_FROM = "Dario Cositore <dario@mail.dariocositore.com>"

import { classifyEmailCandidate, isPecEmail, isSendableOutreachEmail, determineOutreachRoute } from "./email_gate.js"
import { addClient, getClient, updateClient } from "./crm.js"
import { routeClientTrack, validateOfferSelection } from "./routing.js"
import { normalizeItalianCaseSensitiveIA } from "./enrichment.js"
import {
  LOCKED_IT_PIVOT,
  LOCKED_IT_SIGNATURE,
  approveDrafts,
  readDraft,
  replaceCaseSensitiveAI,
  sendApproved,
  validateTouch1Draft,
  writeDraft,
} from "./outreach.js"
import { serializeReadyLead } from "./crmview.js"

describe("Hard Email Routing Gate", () => {
  test("blocks hard-blocked addresses; allows amministrazione/direzione/ufficio and other non-blocked", () => {
    // hard-blocked: legal & privacy
    expect(isSendableOutreachEmail("privacy@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("dpo@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("gdpr@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("legale@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("legal@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    // hard-blocked: invoicing & unmonitored
    expect(isSendableOutreachEmail("fatture@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("fatturazione@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("sdi@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("noreply@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("no-reply@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    // PEC locals
    expect(isPecEmail("pec@studiorossi.it")).toBe(true)
    expect(isPecEmail("postacertificata@studiorossi.it")).toBe(true)
    expect(isPecEmail("certificata@studiorossi.it")).toBe(true)
    expect(isSendableOutreachEmail("pec@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isSendableOutreachEmail("certificata@studiorossi.it", { website: "studiorossi.it" })).toBe(false)
    expect(isPecEmail("studiorossi@postecert.it")).toBe(true)
    expect(isSendableOutreachEmail("studiorossi@postecert.it", { website: "studiorossi.it" })).toBe(false)
    expect(isPecEmail("info@studio.pec.it")).toBe(true)
    expect(isPecEmail("info@legalmail.it")).toBe(true)
    expect(isPecEmail("info@arubapec.it")).toBe(true)
    expect(isPecEmail("info@telecompost.it")).toBe(true)
    // external DPO domain
    expect(isSendableOutreachEmail("avv.bianchi@studiolegaleesterno.it", { website: "clinicarossi.it" })).toBe(false)
    // newly allowed (fallback tier + B2B)
    expect(isSendableOutreachEmail("amministrazione@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("direzione@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("ufficio@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("marketing@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("commerciale@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("vendite@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("lavoraconnoi@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("hr@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
    expect(isSendableOutreachEmail("candidature@studiorossi.it", { website: "studiorossi.it" })).toBe(true)
  })

  test("ranks direct_person > front_desk > generic_info", () => {
    const p = classifyEmailCandidate("marco.rossi@studiorossi.it", { website: "studiorossi.it" })!
    const f = classifyEmailCandidate("segreteria@studiorossi.it", { website: "studiorossi.it" })!
    const g = classifyEmailCandidate("info@studiorossi.it", { website: "studiorossi.it" })!
    expect(p.bucket).toBe("direct_person")
    expect(f.bucket).toBe("front_desk")
    expect(g.bucket).toBe("generic_info")
    expect(p.rank).toBeGreaterThan(f.rank)
    expect(f.rank).toBeGreaterThan(g.rank)
  })
})

describe("Refinement #2: Case-Sensitive AI -> IA Replacement", () => {
  test("converts uppercase AI / A.I. to IA while preserving lowercase 'ai' prepositions", () => {
    const sample = "Inviamo risposte ai pazienti e ai reparti usando sistemi AI e agenti A.I. dedicati ai medici."
    const out1 = replaceCaseSensitiveAI(sample)
    const out2 = normalizeItalianCaseSensitiveIA(sample)
    expect(out1).toBe("Inviamo risposte ai pazienti e ai reparti usando sistemi IA e agenti IA dedicati ai medici.")
    expect(out2).toBe(out1)
    expect(out1).toContain("ai pazienti")
    expect(out1).toContain("ai reparti")
    expect(out1).toContain("ai medici")
  })
})

describe("Italian Offer Track & Stale Language Bug Fix", () => {
  test("never resets Italian lead offer_track to en_discovery_0 when language updates from en -> it", () => {
    const { client } = addClient({
      name: "Studio Dentistico Verdi",
      address: "Via Roma 12, 26012 Castelleone CR",
      website: "studiodentisticoverdi.it",
      language: "en", // default on scout insert
    })
    updateClient(client.id, { language: "it", notes: "Modulo contatti sul sito e WhatsApp attivo per appuntamenti." })
    const res = validateOfferSelection(client, { offer_track: "entry", offer_rationale: "Local dental intake" })
    expect(res.offer_track).toBe("it_local_micro_490")
    expect(getClient(client.id)?.offer_track).toBe("it_local_micro_490")
  })
})

describe("Refinement #1 & #3: Touch 1 Validator, Queue-Only Gate & Resend Signature Preservation", () => {
  test("measures 85-125 words on 4-beat body ONLY, blocks pricing/banned words, and sends verbatim signature + P.S.", async () => {
    let capturedPayload: any = null
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedPayload = await req.json()
        return new Response(JSON.stringify({ id: "re_mock_123" }), { status: 200 })
      },
    })
    process.env.RESEND_URL = `http://127.0.0.1:${server.port}/emails`

    try {
      const { client } = addClient({
        name: "Poliambulatorio San Marco",
        email: "segreteria@sanmarcocrema.it",
        website: "sanmarcocrema.it",
        address: "Via Diaz 8, 26013 Crema CR",
        language: "it",
      })

      const body4Beat = [
        "Buongiorno, una domanda diretta: quando un paziente vi scrive dal modulo sul vostro sito scegliendo tra le diverse visite specialistiche, smistate le richieste a mano ai reparti oppure usate già un filtro automatico?",
        "",
        "Te lo chiedo perché negli studi con più specialisti è quasi sempre il passaggio tra modulo web, WhatsApp e agenda a rallentare le prime risposte ai pazienti.",
        "",
        "Lavoro con studi che vogliono togliere questo lavoro ripetitivo. La maggior parte mi chiede di impostare Assistenti personali IA che leggono le richieste in arrivo, le smistano al referente giusto, preparano bozze di risposta e tengono in ordine l'agenda.",
        "",
        LOCKED_IT_PIVOT,
      ].join("\n")

      const v = validateTouch1Draft({ subject: "Domanda per Poliambulatorio San Marco", body: body4Beat }, "it")
      expect(v.ok).toBe(true)
      expect(v.word_count).toBeGreaterThanOrEqual(85)
      expect(v.word_count).toBeLessThanOrEqual(125)

      // Rejects pricing in Touch 1
      const withPrice = validateTouch1Draft(
        { subject: "Domanda per Poliambulatorio San Marco", body: body4Beat.replace("approfondire?", "approfondire con un audit da €150?") },
                                            "it",
      )
      expect(withPrice.ok).toBe(false)

      const { filePath, row } = writeDraft(client.id, {
        subject: "Domanda per Poliambulatorio San Marco",
        body: body4Beat,
      })
      expect(row.approved).toBe(0) // Strictly queue-only

      const parsedDraft = readDraft(filePath)!
      expect(parsedDraft.body).not.toContain("P.S.") // Clean body for word-count/editor
      expect(parsedDraft.sendText).toContain(LOCKED_IT_SIGNATURE) // Full verbatim signature for wire send

      approveDrafts([row.id])
      const sent = await sendApproved([row.id])
      expect(sent.sent).toEqual([row.id])
      expect(capturedPayload.text).toEndWith(LOCKED_IT_SIGNATURE)
      expect(capturedPayload.text).toContain("senza dover cambiare gestionale o abitudini in segreteria.")
    } finally {
      server.stop(true)
    }
  })

  test("blocks writeDraft on privacy@ / dpo@ / postecert.it and serializes phone_and_form_script on phone_only leads", () => {
    const { client: bad } = addClient({
      name: "Clinica Rossi",
      email: "dpo@clinicarossi.it",
      website: "clinicarossi.it",
      language: "it",
    })
    expect(() => writeDraft(bad.id, { subject: "Domanda Clinica", body: "Test" })).toThrow()

    const route = determineOutreachRoute({
      email_candidates: [],
      whatsapp: { detected: true, phone_or_url: "[https://wa.me/393331234567](https://wa.me/393331234567)", prefilled_text: null },
                                         phones_found: ["+39 0373 123456"],
                                         forms: [],
    })
    expect(route).toBe("whatsapp_only")

    const readyObj = serializeReadyLead({
      id: 999,
      name: "Termoidraulica Bianchi",
      address: "Castelleone CR",
      language: "it",
      outreach_route: "phone_only",
      enrichment_json: JSON.stringify({
        schema_version: "2.0",
        outreach_route: "phone_only",
        audit: { locations_count: 1, channels_detected: ["phone", "contact_form"], team_count_hint: { band: "2-5" } },
        synthesis: {
          business_summary: "Impresa termoidraulica a Castelleone.",
          pain_category: "lead_intake",
          phone_and_form_script: {
            channel: "phone",
            phone_opener: "Buongiorno, sono Dario Cositore...",
            written_message: "Buongiorno, una domanda diretta...",
          },
        },
      }),
    }) as any
    expect(readyObj.enrichment_signals.phone_and_form_script.channel).toBe("phone")
  })
})
