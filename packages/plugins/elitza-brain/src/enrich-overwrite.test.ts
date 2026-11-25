import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-enrich-test-"))
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")
process.env.AI_ENABLEMENT_HOME = home
process.env.ELITZA_HOME = home

// Offline-safe: stub global fetch so external hosts never hit the network.
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input))
    if (url.includes("127.0.0.1") || url.includes("localhost")) {
      return originalFetch(input, init)
    }
    // External hosts: return 404 immediately, no network.
    return new Response("", { status: 404 })
  }) as any
})
afterAll(() => { globalThis.fetch = originalFetch })

const { addClient, getClient } = await import("./crm.js")
const { enrichClient } = await import("./enrichment.js")

let server: ReturnType<typeof Bun.serve>
let url: string
beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("<html><body>Contact us at newemail@test.com</body></html>", { headers: { "content-type": "text/html" } }) })
  url = `http://127.0.0.1:${server.port}`
})
afterAll(() => { server.stop(true); fs.rmSync(home, { recursive: true, force: true }) })

describe("enrichClient does not overwrite existing email", () => {
  test("existing email preserved", async () => {
    const { client } = addClient({ name: "Test Biz", website: url, email: "original@test.com" })
    await enrichClient(client.id).catch(() => {})
    const after = getClient(client.id)
    expect(after?.email).toBe("original@test.com")
  }, 20000)
})
