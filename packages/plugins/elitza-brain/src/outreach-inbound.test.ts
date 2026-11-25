import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-outreach-test-"))
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")
process.env.AI_ENABLEMENT_HOME = home
process.env.ELITZA_HOME = home

const { addClient, crmDb } = await import("./crm.js")
const { addToPipeline } = await import("./outreach.js")
const { queueFollowups } = await import("./outreach.js")

afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe("queueFollowups skips inbound reply", () => {
  test("skips when inbound email after last touch", () => {
    const { client } = addClient({ name: "Biz", email: "biz@example.com" })
    addToPipeline(client.id)
    const now = new Date().toISOString()
    const past = new Date(Date.now() - 10000).toISOString()
    crmDb().run("UPDATE pipeline SET touch=1, queued_touch=1, last_touch_at=?, next_touch_at=? WHERE client_id=?", [past, past, client.id])
    // inbound email after last touch
    crmDb().run("INSERT INTO emails (folder,direction,from_addr,to_addr,subject,body,occurred_at,created_at,updated_at,client_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ["inbox","in","biz@example.com","me@example.com","re: hi","thanks", now, now, now, client.id])
    const res = queueFollowups()
    const skipped = res.skipped.find((s) => s.reason === "inbound reply detected after last touch")
    expect(skipped).toBeTruthy()
  })
})
