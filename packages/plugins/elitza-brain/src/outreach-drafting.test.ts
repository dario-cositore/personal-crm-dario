import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-drafttest-"))
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")
process.env.AI_ENABLEMENT_HOME = home
process.env.ELITZA_HOME = home
process.env.RESEND_API_KEY = "test-key"
process.env.RESEND_FROM = "Dario <dario@mail.dariocositore.com>"

const server = Bun.serve({ port: 0, fetch: async () => new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "Content-Type": "application/json" } }) })
process.env.RESEND_URL = `http://127.0.0.1:${server.port}`

const { addClient } = await import("./crm.js")
const outreach = await import("./outreach.js")

afterAll(() => { server.stop(true); fs.rmSync(home, { recursive: true, force: true }) })

describe("outreach drafting guardrails", () => {
  test("writeDraft strips duplicate signature so it appears exactly once", () => {
    const { client } = addClient({ name: "BizDraft", email: "bizdraft@studiorossi.it", language: "it", address: "Castelleone, CR" })
    outreach.addToPipeline(client.id)
    const bodyWithSig = "Ciao,\n\nTesto di prova.\n\nUn saluto,\nDario Cositore\nAutomazione e Sistemi Operativi"
    outreach.writeDraft(client.id, { subject: "hi", body: bodyWithSig })
    const row = outreach.listPipeline().find((r: any) => r.client_id === client.id)!
    const text = fs.readFileSync(row.draft_path as string, "utf8")
    const count = (text.match(/Un saluto,/g) || []).length
    expect(count).toBe(1)
  })

  test("Italian rendered draft has no AI/flusso/enums/placeholders", () => {
    const { client } = addClient({ name: "Biz2Draft", email: "biz2draft@studiorossi.it", language: "it", address: "Milano, MI" })
    outreach.addToPipeline(client.id)
    outreach.writeDraft(client.id, { subject: "hi2", body: "Ciao {{NAME}} doc_automation lead_intake flusso AI test" })
    const row = outreach.listPipeline().find((r: any) => r.client_id === client.id)!
    const text = fs.readFileSync(row.draft_path as string, "utf8")
    expect(text).not.toContain("flusso")
    expect(text).not.toContain("doc_automation")
    expect(text).not.toContain("lead_intake")
    expect(text).not.toContain("{{")
    expect(text).toContain("IA")
  })

  test("Castelleone lead includes local hook", () => {
    const { client } = addClient({ name: "CastBizDraft", email: "castdraft@studiorossi.it", language: "it", address: "Castelleone, CR" })
    outreach.addToPipeline(client.id)
    outreach.writeDraft(client.id, { subject: "hi3", body: "Ciao, testo breve." })
    const row = outreach.listPipeline().find((r: any) => r.client_id === client.id)!
    const text = fs.readFileSync(row.draft_path as string, "utf8")
    expect(text.toLowerCase()).toContain("ti scrivo qui da castelleone")
  })

  test("Milan lead includes local hook", () => {
    const { client } = addClient({ name: "MilanBizDraft", email: "milandraft@studiorossi.it", language: "it", address: "Milano, MI" })
    outreach.addToPipeline(client.id)
    outreach.writeDraft(client.id, { subject: "hi4", body: "Ciao, testo breve." })
    const row = outreach.listPipeline().find((r: any) => r.client_id === client.id)!
    const text = fs.readFileSync(row.draft_path as string, "utf8")
    expect(text.toLowerCase()).toContain("ti scrivo da milano")
  })
})

describe("outbound loop approval gate", () => {
  test("runOutboundLoopTick leaves drafts unapproved and respects auto_stop_at", async () => {
    process.env.ELITZA_AUTO_STOP_AT = new Date(Date.now() - 1000).toISOString()
    const { runOutboundLoopTick } = await import("./heartbeat.js")
    const r = await runOutboundLoopTick()
    expect(r.skipped).toBe("auto_stop_at reached")
    delete process.env.ELITZA_AUTO_STOP_AT
  })
})