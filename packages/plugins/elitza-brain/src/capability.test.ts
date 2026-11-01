import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-cap-test-"))
process.env.ELITZA_HOME = home

const { issue, verifyToken, delegate, revoke, covers, listIssued, listRevoked, attachSession, detachSession, getSessionCapability } = await import("./capability.js")

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe("capability tokens", () => {
  test("mint + verify round trip", () => {
    const tok = issue({ audience: "agent:scout", capabilities: [{ action: "read", resource: "*" }], expiryMinutes: 10 })
    const r = verifyToken(tok, "agent:scout")
    expect(r.ok).toBe(true)
    expect(r.claims?.aud).toBe("agent:scout")
  })

  test("wrong audience fails", () => {
    const tok = issue({ audience: "agent:scout", capabilities: [{ action: "read", resource: "*" }], expiryMinutes: 10 })
    const r = verifyToken(tok, "agent:other")
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("audience mismatch")
  })

  test("covers checks action/resource", () => {
    const tok = issue({ audience: "a", capabilities: [{ action: "read", resource: "client:*" }], expiryMinutes: 10 })
    expect(covers(tok, "read", "client:1")).toBe(true)
    expect(covers(tok, "write", "client:1")).toBe(false)
    expect(covers(tok, "read", "secret:1")).toBe(false)
  })

  test("expired token fails", () => {
    const tok = issue({ audience: "a", capabilities: [{ action: "*", resource: "*" }], expiryMinutes: -1 })
    const r = verifyToken(tok)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("expired")
  })

  test("revoke blocks verification", () => {
    const tok = issue({ audience: "a", capabilities: [{ action: "*", resource: "*" }], expiryMinutes: 10 })
    const claims = verifyToken(tok).claims!
    revoke(claims.nonce)
    expect(verifyToken(tok).ok).toBe(false)
    expect(verifyToken(tok).reason).toBe("revoked")
    expect(listRevoked()).toContain(claims.nonce)
  })

  test("delegation requires delegatable parent", () => {
    const parent = issue({ audience: "a", capabilities: [{ action: "read", resource: "*" }], expiryMinutes: 30, delegatable: false })
    const child = delegate(parent, { audience: "b", capabilities: [{ action: "read", resource: "*" }], expiryMinutes: 10 })
    expect(child).toBeNull()
  })

  test("delegation works when delegatable and subset", () => {
    const parent = issue({ audience: "a", capabilities: [{ action: "read", resource: "*" }], expiryMinutes: 30, delegatable: true })
    const child = delegate(parent, { audience: "b", capabilities: [{ action: "read", resource: "client:*" }], expiryMinutes: 10 })
    expect(child).not.toBeNull()
    const r = verifyToken(child!)
    expect(r.ok).toBe(true)
    expect(r.claims?.parent).toBe(verifyToken(parent).claims?.nonce)
  })

  test("delegation rejects non-subset capabilities", () => {
    const parent = issue({ audience: "a", capabilities: [{ action: "read", resource: "*" }], expiryMinutes: 30, delegatable: true })
    const child = delegate(parent, { audience: "b", capabilities: [{ action: "write", resource: "*" }], expiryMinutes: 10 })
    expect(child).toBeNull()
  })

  test("session attach/detach", () => {
    const tok = issue({ audience: "s", capabilities: [{ action: "*", resource: "*" }], expiryMinutes: 10 })
    attachSession("ses_1", tok)
    expect(getSessionCapability("ses_1")).toBe(tok)
    detachSession("ses_1")
    expect(getSessionCapability("ses_1")).toBeNull()
  })

  test("tampered token fails", () => {
    const tok = issue({ audience: "a", capabilities: [{ action: "*", resource: "*" }], expiryMinutes: 10 })
    const tampered = tok.slice(0, -4) + "AAAA"
    expect(verifyToken(tampered).ok).toBe(false)
  })
})