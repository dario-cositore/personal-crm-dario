/**
 * Elitza Brain — cryptographic identity (Task: signed handovers).
 *
 * Mirrors gitlawb's core promise ("every push is signed by the key that
 * made it"): Elitza holds an Ed25519 keypair under ~/.ai-enablement-agent and signs the
 * artefacts she produces (today: CLIENT_SOP_HANDOVER.md). A recipient can
 * verify the signature against her published public key without trusting any
 * intermediary — the signature is the proof, the same way a gitlawb
 * ref-update certificate is the proof of a push.
 *
 * Key material is stored as PEM (PKCS#8 private, SPKI public) so it is
 * readable by any standard tool (openssl, ssh-keygen) and never leaves the
 * machine unless the operator copies it. The private key file is created
 * mode 0600.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { AI_ENABLEMENT_HOME as _AI_ENABLEMENT_HOME } from "./db.js"

export function privateKeyPath(): string { return path.join((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) ?? _AI_ENABLEMENT_HOME, "identity.pem") }
export function publicKeyPath(): string { return path.join((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) ?? _AI_ENABLEMENT_HOME, "identity.pub") }

export interface ElitzaIdentity {
  privateKey: crypto.KeyObject
  publicKey: crypto.KeyObject
  /** base64 (standard) of the raw 32-byte public key, for compact embedding. */
  publicKeyBase64: string
  /** DID-style identifier: did:key is too heavy here, so we use a simple
   *  `elitza:` prefix + base64url public key, matching gitlawb's did:key
   *  spirit without pulling in a DID resolver. */
  id: string
}

function ensureHome(): void {
  fs.mkdirSync((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) ?? _AI_ENABLEMENT_HOME, { recursive: true })
}

function loadOrCreate(): ElitzaIdentity {
  ensureHome()
  let privateKey: crypto.KeyObject
  let publicKey: crypto.KeyObject

  if (fs.existsSync(privateKeyPath())) {
    const pem = fs.readFileSync(privateKeyPath(), "utf8")
    privateKey = crypto.createPrivateKey(pem)
    publicKey = crypto.createPublicKey(privateKey)
  } else {
    const pair = crypto.generateKeyPairSync("ed25519")
    privateKey = pair.privateKey
    publicKey = pair.publicKey
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string
    fs.writeFileSync(privateKeyPath(), privPem, { mode: 0o600 })
    try { fs.chmodSync(privateKeyPath(), 0o600) } catch { /* best effort */ }
    fs.writeFileSync(publicKeyPath(), pubPem, { mode: 0o644 })
  }

  // Make sure a public file always exists even if only the private one did.
  if (!fs.existsSync(publicKeyPath())) {
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string
    fs.writeFileSync(publicKeyPath(), pubPem, { mode: 0o644 })
  }

  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer
  // SPKI for Ed25519 is 12 bytes prefix + 32 bytes key.
  const raw = spki.subarray(spki.length - 32)
  const publicKeyBase64 = raw.toString("base64")
  const id = `elitza:${raw.toString("base64url")}`

  return { privateKey, publicKey, publicKeyBase64, id }
}

let cached: ElitzaIdentity | null = null

/** Load (or lazily create) Elitza's Ed25519 identity. Cached per process. */
export function getIdentity(): ElitzaIdentity {
  if (cached) return cached
  cached = loadOrCreate()
  return cached
}

/** Sign arbitrary bytes. Returns base64 (standard) signature. */
export function sign(data: Buffer | Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
  return crypto.sign(null, buf, getIdentity().privateKey).toString("base64")
}

/** Verify a signature against a base64 public key. */
export function verify(data: Buffer | Uint8Array | string, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
    const sig = Buffer.from(signatureBase64, "base64")
    const raw = Buffer.from(publicKeyBase64, "base64")
    // Rebuild SPKI from raw 32-byte key (Ed25519).
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex")
    const spki = Buffer.concat([spkiPrefix, raw])
    const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" })
    return crypto.verify(null, buf, pub, sig)
  } catch {
    return false
  }
}

/** sha256 hex of bytes/string. */
export function sha256(data: Buffer | Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
  return crypto.createHash("sha256").update(buf).digest("hex")
}