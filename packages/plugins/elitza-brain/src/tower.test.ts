import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-tower-test-"))
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")
process.env.AI_ENABLEMENT_HOME = home
process.env.ELITZA_HOME = home
process.env.TOWER_CALLBACK_SECRET = "shh"

const { addClient, crmDb, getClient, getCustomFields } = await import("./crm.js")
const { addToPipeline } = await import("./outreach.js")
const tower = await import("./tower.js")

afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe("tower callback auth", () => {
  test("401 without valid bearer", async () => {
    const r = await tower.handleTowerCallback({ client_id: 1, action: "update_client" }, null)
    expect(r.status).toBe(401)
  })
  test("401 with wrong secret", async () => {
    const r = await tower.handleTowerCallback({ client_id: 1, action: "update_client" }, "Bearer wrong")
    expect(r.status).toBe(401)
  })
  test("401 when secret unset", async () => {
    const prev = process.env.TOWER_CALLBACK_SECRET
    delete process.env.TOWER_CALLBACK_SECRET
    const r = await tower.handleTowerCallback({ client_id: 1, action: "update_client" }, "Bearer shh")
    process.env.TOWER_CALLBACK_SECRET = prev
    expect(r.status).toBe(401)
  })
})

describe("tower callback actions", () => {
  let clientId: number
  beforeAll(() => {
    const { client } = addClient({ name: "Tower Biz", email: "biz@example.com" })
    clientId = client.id
    addToPipeline(clientId)
  })
  test("update_client patches fields + custom_fields", async () => {
    const r = await tower.handleTowerCallback({ client_id: clientId, action: "update_client", patch: { notes: "updated", risk_score: 80 }, custom_fields: { foo: "bar" } }, "Bearer shh")
    expect(r.status).toBe(200)
    const c = getClient(clientId)
    expect(c?.notes).toBe("updated")
    expect(c?.risk_score).toBe(80)
    expect(getCustomFields(clientId).foo).toBe("bar")
  })
  test("update_client accepts manual_check status", async () => {
    const r = await tower.handleTowerCallback({ client_id: clientId, action: "update_client", patch: { status: "manual_check" } }, "Bearer shh")
    expect(r.status).toBe(200)
    const c = getClient(clientId)
    expect(c?.status).toBe("manual_check")
  })
  test("queue_outreach_draft accepts body.to for email-less client and keeps approved=0", async () => {
    const { client } = addClient({ name: "Emailless Biz", email: null as any })
    addToPipeline(client.id)
    const r = await tower.handleTowerCallback({ client_id: client.id, action: "queue_outreach_draft", subject: "Hi", body: "Body text", to: "info@emaillessbiz.it" }, "Bearer shh")
    expect(r.status).toBe(200)
    const c = getClient(client.id)
    expect(c?.email).toBe("info@emaillessbiz.it")
    const row = crmDb().query("SELECT approved FROM pipeline WHERE client_id = ?").get(client.id) as any
    expect(row.approved).toBe(0)
  })
  test("queue_email_draft creates draft email", async () => {
    const r = await tower.handleTowerCallback({ client_id: clientId, action: "queue_email_draft", subject: "Hi", body: "Body" }, "Bearer shh")
    expect(r.status).toBe(200)
    const row = crmDb().query("SELECT folder, direction FROM emails WHERE client_id = ?").get(clientId) as any
    expect(row.folder).toBe("drafts")
    expect(row.direction).toBe("out")
  })
  test("attach_asset blocks path traversal", async () => {
    const r = await tower.handleTowerCallback({ client_id: clientId, action: "attach_asset", filename: "../evil.md", content: "x" }, "Bearer shh")
    expect(r.status).toBe(400)
  })
  test("attach_asset call_kit stores custom field", async () => {
    const content = { todo: ["a"], scaletta: "script", questions: ["q"], recommended_track: "track1" }
    const r = await tower.handleTowerCallback({ client_id: clientId, action: "attach_asset", kind: "call_kit", name: "kit", filename: "kit.md", content }, "Bearer shh")
    expect(r.status).toBe(200)
    const fields = getCustomFields(clientId)
    expect(fields.tower_call_kit).toBeTruthy()
  })
  test("dispose_outreach disposes pipeline", async () => {
    const r = await tower.handleTowerCallback({ client_id: clientId, action: "dispose_outreach", verdict: "stale", note: "done" }, "Bearer shh")
    expect(r.status).toBe(200)
  })
})

describe("buildTowerPayload", () => {
  test("produces unified bundle", () => {
    const { client } = addClient({ name: "Payload Biz" })
    const p = tower.buildTowerPayload(client.id, "outbound_prep", { x: 1 })
    expect(p.event).toBe("outbound_prep")
    expect(p.client).toBeTruthy()
    expect(Array.isArray(p.recent_interactions)).toBe(true)
    expect(p.event_payload).toEqual({ x: 1 })
    expect(p.callback_url).toBe(process.env.TOWER_CALLBACK_URL || null)
  })
})
