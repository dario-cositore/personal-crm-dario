import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-ws-test-"))
process.env.AI_ENABLEMENT_HOME = home
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")

const { ensureWorksheets, listWorksheets, recommendWorksheets, pullWorksheet, alreadyPulled } = await import("./worksheets.js")
const { addClient } = await import("./crm.js")

afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

describe("worksheets", () => {
  test("seeds all bundled worksheets", () => {
    const written = ensureWorksheets()
    const ws = listWorksheets()
    expect(ws.length).toBe(14)
    expect(ws.every((w) => w.available)).toBe(true)
  })

  test("recommends legal worksheets for a legal client", () => {
    const { client } = addClient({ name: "Studio Legale", vertical: "legal", notes: "CRM duplicates and lead intake" })
    const recs = recommendWorksheets(client, 3)
    expect(recs.length).toBe(3)
    expect(recs.some((w) => w.verticals.includes("legal"))).toBe(true)
  })

  test("pull attaches a worksheet asset", () => {
    const { client } = addClient({ name: "Ops Co", vertical: "ops", notes: "workflow audit" })
    const recs = recommendWorksheets(client, 1)
    const res = pullWorksheet(client.id, recs[0].id)
    expect(fs.existsSync(res.path)).toBe(true)
    expect(alreadyPulled(client.id, recs[0].id)).toBe(true)
  })
})