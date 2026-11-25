import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-dailycap-test-"))
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")
process.env.AI_ENABLEMENT_HOME = home
process.env.ELITZA_HOME = home
process.env.RESEND_API_KEY = "test-key"
process.env.RESEND_FROM = "Dario <dario@mail.dariocositore.com>"
const server = Bun.serve({ port: 0, fetch: async () => new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "Content-Type": "application/json" } }) })
process.env.RESEND_URL = `http://127.0.0.1:${server.port}`
process.env.OUTREACH_DAILY_CAP = "1"

const { addClient } = await import("./crm.js")
const outreach = await import("./outreach.js")

afterAll(() => { server.stop(true); fs.rmSync(home, { recursive: true, force: true }) })

describe("sendApproved daily cap", () => {
  test("stops with daily cap reached", async () => {
    const { client } = addClient({ name: "BizCap", email: "bizcap@studiorossi.it" })
    outreach.addToPipeline(client.id)
    outreach.writeDraft(client.id, { subject: "hi", body: "body" })
    const row = outreach.listPipeline().find((r: any) => r.client_id === client.id)!
    outreach.approveDrafts([row.id])
    const r1 = await outreach.sendApproved()
    expect(r1.sent.length).toBe(1)

    const { client: c2 } = addClient({ name: "Biz2Cap", email: "biz2cap@studiorossi.it" })
    outreach.addToPipeline(c2.id)
    outreach.writeDraft(c2.id, { subject: "hi2", body: "body2" })
    const row2 = outreach.listPipeline().find((r: any) => r.client_id === c2.id)!
    outreach.approveDrafts([row2.id])
    const r2 = await outreach.sendApproved()
    expect(r2.failed.some((f: any) => f.reason === "daily cap reached")).toBe(true)
  })
})
