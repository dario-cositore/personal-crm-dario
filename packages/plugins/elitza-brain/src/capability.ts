/**
 * Elitza Brain — capability tokens (UCAN-inspired).
 *
 * A capability token is a signed statement: "issuer grants audience the
 * ability to perform `action` on `resource`, valid from nbf until exp".
 * Tokens are signed with Elitza's Ed25519 identity, so any holder can
 * verify them offline without trusting an intermediary — the same property
 * gitlawb's ref-update certificates have.
 *
 * Tokens can be delegated (if `delegatable`) to a narrower audience with a
 * subset of capabilities and an expiry no later than the parent's. Revoked
 * nonces are persisted under ~/.elitza so revocation survives restarts.
 *
 * Stored form: `cap.<base64url(payload)>.<base64url(signature)>`.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ELITZA_HOME as _ELITZA_HOME } from "./db.js"
import { getIdentity, sign, verify, sha256 } from "./identity.js"

export function revokedPath(): string { return path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "revoked-capabilities.json") }
export function issuedPath(): string { return path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "issued-capabilities.json") }

export interface Capability {
  action: string
  resource: string
}

export interface CapabilityClaims {
  iss: string
  aud: string
  cap: Capability[]
  iat: string
  nbf: string
  exp: string
  nonce: string
  delegatable: boolean
  parent?: string
}

export interface IssueInput {
  audience: string
  capabilities: Capability[]
  /** Expiry in minutes from now (default 60). */
  expiryMinutes?: number
  /** Not-before offset in minutes from now (default 0). */
  notBeforeMinutes?: number
  delegatable?: boolean
  parent?: string
}

export interface VerifyResult {
  ok: boolean
  reason?: string
  claims?: CapabilityClaims
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

function loadRevoked(): Set<string> {
  try {
    const raw = fs.readFileSync(revokedPath(), "utf8")
    const arr = JSON.parse(raw) as string[]
    return new Set(arr)
  } catch {
    return new Set()
  }
}

function saveRevoked(set: Set<string>): void {
  fs.mkdirSync(process.env.ELITZA_HOME ?? _ELITZA_HOME, { recursive: true })
  fs.writeFileSync(revokedPath(), JSON.stringify([...set], null, 2), { mode: 0o600 })
}

function loadIssued(): CapabilityClaims[] {
  try {
    const raw = fs.readFileSync(issuedPath(), "utf8")
    return JSON.parse(raw) as CapabilityClaims[]
  } catch {
    return []
  }
}

function saveIssued(list: CapabilityClaims[]): void {
  fs.mkdirSync(process.env.ELITZA_HOME ?? _ELITZA_HOME, { recursive: true })
  // Keep last 500.
  const trimmed = list.slice(-500)
  fs.writeFileSync(issuedPath(), JSON.stringify(trimmed, null, 2), { mode: 0o600 })
}

function wildcardMatch(pattern: string, value: string): boolean {
  // Simple glob: * matches any run of chars.
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  return re.test(value)
}

export function issue(input: IssueInput): string {
  const id = getIdentity()
  const now = new Date()
  const nbf = new Date(now.getTime() + (input.notBeforeMinutes ?? 0) * 60_000)
  const exp = new Date(now.getTime() + (input.expiryMinutes ?? 60) * 60_000)
  const claims: CapabilityClaims = {
    iss: id.id,
    aud: input.audience,
    cap: input.capabilities,
    iat: now.toISOString(),
    nbf: nbf.toISOString(),
    exp: exp.toISOString(),
    nonce: crypto.randomUUID(),
    delegatable: input.delegatable ?? false,
    parent: input.parent,
  }
  const payload = b64url(JSON.stringify(claims))
  const sigBytes = Buffer.from(sign(payload), "base64")
  const token = `cap.${payload}.${b64url(sigBytes)}`
  const issued = loadIssued()
  issued.push(claims)
  saveIssued(issued)
  return token
}

export function parse(token: string): CapabilityClaims | null {
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== "cap") return null
  try {
    return JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as CapabilityClaims
  } catch {
    return null
  }
}

export function verifyToken(token: string, expectedAudience?: string): VerifyResult {
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== "cap") return { ok: false, reason: "malformed token" }
  const payloadB64 = parts[1]
  const sigB64 = parts[2]
  let claims: CapabilityClaims
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as CapabilityClaims
  } catch {
    return { ok: false, reason: "invalid payload" }
  }
  const selfOk = verify(payloadB64, b64urlDecode(sigB64).toString("base64"), getIdentity().publicKeyBase64)
  if (!selfOk) return { ok: false, reason: "bad signature" }

  const now = Date.now()
  if (Date.parse(claims.nbf) > now) return { ok: false, reason: "not yet valid" }
  if (Date.parse(claims.exp) < now) return { ok: false, reason: "expired" }
  if (expectedAudience && claims.aud !== expectedAudience) return { ok: false, reason: "audience mismatch" }

  const revoked = loadRevoked()
  if (revoked.has(claims.nonce)) return { ok: false, reason: "revoked" }

  return { ok: true, claims }
}

export function covers(token: string, action: string, resource: string): boolean {
  const r = verifyToken(token)
  if (!r.ok || !r.claims) return false
  return r.claims.cap.some((c) => wildcardMatch(c.action, action) && wildcardMatch(c.resource, resource))
}

export function delegate(parentToken: string, input: { audience: string; capabilities: Capability[]; expiryMinutes?: number; delegatable?: boolean }): string | null {
  const r = verifyToken(parentToken)
  if (!r.ok || !r.claims) return null
  if (!r.claims.delegatable) return null
  // Subset check: every requested cap must be covered by parent.
  for (const c of input.capabilities) {
    if (!r.claims.cap.some((pc) => wildcardMatch(pc.action, c.action) && wildcardMatch(pc.resource, c.resource))) {
      return null
    }
  }
  const parentExp = Date.parse(r.claims.exp)
  const requestedExp = Date.now() + (input.expiryMinutes ?? 30) * 60_000
  const exp = Math.min(requestedExp, parentExp)
  if (exp <= Date.now()) return null
  const expiryMinutes = Math.max(1, Math.round((exp - Date.now()) / 60_000))
  return issue({
    audience: input.audience,
    capabilities: input.capabilities,
    expiryMinutes,
    delegatable: input.delegatable ?? false,
    parent: r.claims.nonce,
  })
}

export function revoke(nonce: string): void {
  const set = loadRevoked()
  set.add(nonce)
  saveRevoked(set)
}

export function listIssued(): CapabilityClaims[] {
  return loadIssued()
}

export function listRevoked(): string[] {
  return [...loadRevoked()]
}
// ---------------------------------------------------------------------------
// Session attachment: map a session id to a capability token.
// ---------------------------------------------------------------------------

function loadSessionCaps(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "session-capabilities.json"), "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

function saveSessionCaps(map: Record<string, string>): void {
  fs.mkdirSync(process.env.ELITZA_HOME ?? _ELITZA_HOME, { recursive: true })
  fs.writeFileSync(path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "session-capabilities.json"), JSON.stringify(map, null, 2), { mode: 0o600 })
}

export function attachSession(sessionID: string, token: string): void {
  const map = loadSessionCaps()
  map[sessionID] = token
  saveSessionCaps(map)
}

export function detachSession(sessionID: string): void {
  const map = loadSessionCaps()
  delete map[sessionID]
  saveSessionCaps(map)
}

export function getSessionCapability(sessionID: string): string | null {
  const map = loadSessionCaps()
  return map[sessionID] ?? null
}
