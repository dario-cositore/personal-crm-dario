import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-tpl-test-"))
process.env.ELITZA_HOME = home

// crm needs its own db path
const crmHome = path.join(home, "crm")
fs.mkdirSync(crmHome, { recursive: true })
process.env.ELITZA_CRM_DB = path.join(crmHome, "crm.db")

const { seedTemplates, listTemplates, getTemplate, instantiateTemplate } = await import("./templates.js")
const { addClient } = await import("./crm.js")

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe("templates", () => {
  test("seed creates templates", () => {
    const seeded = seedTemplates()
    expect(seeded.length).toBeGreaterThan(0)
    expect(listTemplates()).toContain("lead-capture-webhook")
  })

  test("getTemplate returns manifest", () => {
    const t = getTemplate("invoice-reminder")
    expect(t?.category).toBe("billing")
    expect(t?.files.length).toBeGreaterThan(0)
  })

  test("instantiate creates files and registers asset", () => {
    const { client } = addClient({ name: "Test Farm", email: "a@b.com" })
    const res = instantiateTemplate("lead-capture-webhook", client.id)
    expect(res).not.toBeNull()
    expect(res!.files).toContain("README.md")
    const content = fs.readFileSync(path.join(res!.dir, "README.md"), "utf8")
    expect(content).toContain("Test Farm")
  })

  test("instantiate unknown template returns null", () => {
    const { client } = addClient({ name: "X" })
    expect(instantiateTemplate("nope", client.id)).toBeNull()
  })
})
