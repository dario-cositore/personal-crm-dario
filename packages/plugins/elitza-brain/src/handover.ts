/**
 * Elitza Brain — the SOP / handover generator (Task 3).
 *
 * Writes CLIENT_SOP_HANDOVER.md for a delivered job: what runs where, which
 * environment variables it needs (names only — values live in mode-600
 * files and never reach this document), how to run and check it, how to
 * recover, what needs a human yes, and who owns it afterwards.
 *
 * Everything in the document is read from evidence, never from memory of
 * the project:
 *
 *   git log / git status      what actually changed, when, by which commit
 *   git ls-files scan         environment variable names in tracked source
 *   package.json              scripts, license, name
 *   git remote                where the code lives
 *   engine config + soul      the approval gates that are really in force
 *
 * Section headings match the client-handover playbook, so the generator and
 * the teaching layer describe the same document.
 */

import fs from "node:fs"
import path from "node:path"
import { nowISO } from "./db.js"
import { soulGet } from "./soul.js"
import { engineConfigPath } from "./configview.js"
import { getIdentity, sign, sha256, verify } from "./identity.js"

const ENV_PATTERN = /process\.env\.([A-Z][A-Z0-9_]+)|os\.environ(?:\.get)?\(?[["']([A-Z][A-Z0-9_]+)/g
const SECRET_HINT = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".json", ".md", ".yml", ".yaml", ".example"]
const MAX_FILE_BYTES = 256_000
const MAX_FILES = 800

export interface HandoverOptions {
  /** Repository (or any folder inside one) the document describes. */
  repo: string
  /** Where to write. Defaults to CLIENT_SOP_HANDOVER.md at the repo root. */
  out?: string
  /** CRM client this delivery belongs to, so the document names them. */
  clientID?: number
}

export interface HandoverResult {
  path: string
  commits: number
  env_vars: string[]
  sections: string[]
  signed: boolean
  public_key: string
  signature_path: string
  sha256: string
}

function git(repo: string, args: string[]): string {
  try {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) return ""
    return new TextDecoder().decode(result.stdout).trim()
  } catch {
    return ""
  }
}

/** Environment variable names referenced by tracked source, sorted, deduped. */
function findEnvVars(repo: string): string[] {
  const files = git(repo, ["ls-files"]).split("\n").filter(Boolean)
  const found = new Set<string>()
  let scanned = 0
  for (const file of files) {
    if (scanned >= MAX_FILES) break
    if (!SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension))) continue
    const full = path.join(repo, file)
    let text: string
    try {
      const stat = fs.statSync(full)
      if (stat.size > MAX_FILE_BYTES) continue
      text = fs.readFileSync(full, "utf8")
    } catch {
      continue
    }
    scanned++
    for (const match of text.matchAll(ENV_PATTERN)) {
      const name = match[1] ?? match[2]
      if (name) found.add(name)
    }
    if (file.endsWith(".env.example") || file.endsWith(".example")) {
      for (const line of text.split("\n")) {
        const declared = /^([A-Z][A-Z0-9_]+)=/.exec(line.trim())
        if (declared) found.add(declared[1])
      }
    }
  }
  return [...found].sort()
}

function permissionGates(): string[] {
  const gates: string[] = []
  try {
    const config = JSON.parse(fs.readFileSync(engineConfigPath(), "utf8")) as {
      permission?: Record<string, string>
    }
    for (const [tool, mode] of Object.entries(config.permission ?? {})) {
      if (mode === "ask") gates.push(`${tool}: ask before every use`)
    }
  } catch {
    // Config unreadable — the standing rules below still apply.
  }
  const operatorGates = soulGet("permission_gates", "").trim()
  if (operatorGates) gates.push(`operator's own words: ${operatorGates}`)
  return gates
}

function packageFacts(repo: string): { name: string; scripts: [string, string][]; license: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
      name?: string
      license?: string
      scripts?: Record<string, string>
    }
    return {
      name: pkg.name ?? path.basename(repo),
      scripts: Object.entries(pkg.scripts ?? {}).slice(0, 8),
      license: pkg.license ?? "not declared",
    }
  } catch {
    return { name: path.basename(repo), scripts: [], license: "not declared" }
  }
}

/**
 * Generate the handover document. Returns where it went and what fed it, so
 * the caller can report honestly (an empty git log is a fact, not a silence).
 */
export function generateHandover(options: HandoverOptions): HandoverResult {
  const repo = path.resolve(options.repo)
  if (!fs.existsSync(repo)) throw new Error(`No such folder: ${repo}`)
  const isGit = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" })
  if (isGit.exitCode !== 0) {
    throw new Error(`Not a git repository: ${repo}. Pass repo= pointing at a project folder with a .git directory.`)
  }

  const log = git(repo, ["log", "-n", "15", "--pretty=format:%h %ad %s", "--date=short"])
  const commits = log ? log.split("\n").length : 0
  const remote = git(repo, ["remote", "get-url", "origin"])
  const porcelain = git(repo, ["status", "--porcelain"])
  const dirty = porcelain ? porcelain.split("\n").filter(Boolean).length : 0
  const pkg = packageFacts(repo)
  const envVars = findEnvVars(repo)
  const gates = permissionGates()
  const entries = fs
    .readdirSync(repo, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .slice(0, 24)

  const clientLine = options.clientID
    ? `Delivery recorded for CRM client ${options.clientID}.`
    : "No CRM client linked to this document."

  const sections = ["Architecture", "Environment and secrets", "Daily operation", "Maintenance", "Edge cases and recovery", "Approval gates", "Support and ownership"]

  const body = [
    "# CLIENT SOP & HANDOVER",
    "",
    `_Generated by Elitza on ${nowISO().slice(0, 10)} from ${repo}. Evidence below comes from git, the tracked source and the live config — not from memory of the project._`,
    "",
    "## Architecture",
    "",
    `- Project: ${pkg.name} (license: ${pkg.license})`,
    `- Layout: ${entries.join(" ") || "(empty)"}`,
    `- Repository: ${remote || "(local only — no git remote configured)"}`,
    `- Working tree: ${dirty === 0 ? "clean" : `${dirty} uncommitted change(s)`}`,
    "",
    "What changed, newest first:",
    "",
    log ? log.split("\n").map((line) => `- ${line}`).join("\n") : "- No git history available in this folder.",
    "",
    "## Environment and secrets",
    "",
    "Names only. Values live in mode-600 files (for Elitza: ~/.elitza/.env, ~/.config/maton/credentials.env) or the host environment, and never appear in this document.",
    "",
    envVars.length
      ? envVars.map((name) => `- \`${name}\` — ${SECRET_HINT.test(name) ? "secret: mode-600 file, loaded, never echoed" : "plain configuration: host environment or config file"}`).join("\n")
      : "- No environment variables referenced in the scanned source.",
    "",
    "## Daily operation",
    "",
    clientLine,
    pkg.scripts.length
      ? ["Run and check commands:", "", ...pkg.scripts.map(([name, command]) => `- \`${name}\`: ${command}`)].join("\n")
      : "- No package scripts defined; the run command is whatever the folder's own README states.",
    "",
    "## Maintenance",
    "",
    "- Dependency updates monthly, or immediately for a security advisory; re-run the project's check command after every one.",
    "- Keep the database and generated files out of git if they already are (check .gitignore) and back them up separately.",
    "- Re-generate this document after any structural change: it goes stale the moment the architecture moves.",
    "",
    "## Edge cases and recovery",
    "",
    "- Everything recoverable is in git: `git log` to see what changed, `git status` for uncommitted work, `git checkout <commit> -- <path>` to restore one file.",
    "- If a process will not start: check the environment variables above are set, then the port or path it binds to.",
    "- If a database file is corrupt: restore the newest backup copy; do not edit it by hand.",
    "- If this document disagrees with the code, the code wins and this file must be regenerated.",
    "",
    "## Approval gates",
    "",
    gates.length
      ? gates.map((gate) => `- ${gate}`).join("\n")
      : "- No engine permission gates configured (edit, bash, webfetch are unrestricted).",
    "- Nothing outbound is sent without a human approving the batch — outreach drafts wait as files.",
    "- No write to a live domain without explicit confirmation from the owner.",
    "- Secrets stay in mode-600 files: never in documents, repositories, prompts or memory.",
    "",
    "## Support and ownership",
    "",
    `- Code owner: the repository above${remote ? "" : " (no remote — take one before handover)"}`,
    `- Source of truth: this code, plus the git history listed in section one`,
    "- The buyer owns the deliverable and the right to move it elsewhere; the runbook travels with it.",
    "",
  ].join("\n")

  // Sign the document the way gitlawb signs a push: Elitza's Ed25519 key
  // covers the full body, and the public key travels with it so any
  // recipient can verify without trusting an intermediary.
  const identity = getIdentity()
  const digest = sha256(body)
  const signature = sign(body)
  const signatureBlock = [
    "",
    "## Signature",
    "",
    "This document was signed by Elitza's Ed25519 identity. Verify with her public key (below) or with `openssl`/any Ed25519 verifier; the signature covers the entire document above this heading's preceding content.",
    "",
    `- Signer: \`${identity.id}\``,
    `- Public key (base64, raw 32-byte Ed25519): \`${identity.publicKeyBase64}\``,
    `- SHA-256 of signed body: \`${digest}\``,
    `- Signature (base64): \`${signature}\``,
    `- Algorithm: Ed25519 (RFC 8032)`,
    "",
    "A sidecar file with the same fields is written next to this document as `CLIENT_SOP_HANDOVER.md.sig` (or `<out>.sig`).",
    "",
  ].join("\n")

  const signedBody = body + signatureBlock

  const target = path.resolve(options.out ?? path.join(repo, "CLIENT_SOP_HANDOVER.md"))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, signedBody, { mode: 0o644 })

  const sigPath = `${target}.sig`
  fs.writeFileSync(
    sigPath,
    JSON.stringify(
      {
        file: path.basename(target),
        sha256: digest,
        body_length: body.length,
        signature,
        public_key: identity.publicKeyBase64,
        signer: identity.id,
        algorithm: "Ed25519",
        signed_at: nowISO(),
      },
      null,
      2,
    ),
    { mode: 0o644 },
  )

  const sectionsWithSig = [...sections, "Signature"]
  return {
    path: target,
    commits,
    env_vars: envVars,
    sections: sectionsWithSig,
    signed: true,
    public_key: identity.publicKeyBase64,
    signature_path: sigPath,
    sha256: digest,
  }
}

/**
 * Verify a signed handover document. Returns a human-readable report.
 * Reconstructs the signed body (everything before the "## Signature" heading)
 * and checks the Ed25519 signature and SHA-256 digest embedded in it.
 */
export function verifyHandover(file: string): string {
  const target = path.resolve(file)
  if (!fs.existsSync(target)) return `Handover verify: no such file: ${target}`
  const content = fs.readFileSync(target, "utf8")
  const marker = "\n## Signature\n"
  const idx = content.indexOf(marker)
  if (idx === -1) return `Handover verify: no signature block found in ${target}`
  const body = content.slice(0, idx)
  // Parse fields from the signature block.
  const block = content.slice(idx)
  const pubMatch = /Public key \(base64, raw 32-byte Ed25519\): `([^`]+)`/.exec(block)
  const sigMatch = /Signature \(base64\): `([^`]+)`/.exec(block)
  const digestMatch = /SHA-256 of signed body: `([^`]+)`/.exec(block)
  if (!pubMatch || !sigMatch || !digestMatch) {
    return `Handover verify: signature block is incomplete in ${target}`
  }
  const pub = pubMatch[1]
  const sig = sigMatch[1]
  const digest = digestMatch[1]
  const digestOk = sha256(body) === digest
  const sigOk = verify(body, sig, pub)
  // Ensure nothing was appended after the signature block.
  const sidecarNoteIdx = block.indexOf("A sidecar file with the same fields")
  const afterBlock = sidecarNoteIdx === -1
    ? ""
    : block.slice(block.indexOf("\n", sidecarNoteIdx) + 1).trim()
  const noTrailingJunk = afterBlock === ""
  const lines = [
    `Handover verify: ${target}`,
    `SHA-256 match: ${digestOk ? "OK" : "FAIL"}`,
    `Ed25519 signature: ${sigOk ? "OK" : "FAIL"}`,
    `Trailing junk after signature block: ${noTrailingJunk ? "none" : "DETECTED"}`,
    `Signer public key: ${pub}`,
  ]
  // Also check sidecar if present.
  const sidecar = `${target}.sig`
  if (fs.existsSync(sidecar)) {
    try {
      const meta = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { sha256: string; signature: string; public_key: string; body_length?: number }
      const lengthOk = meta.body_length === undefined || meta.body_length === body.length
      lines.push(`Sidecar present: sha256 ${meta.sha256 === digest ? "matches" : "MISMATCH"}, signature ${meta.signature === sig ? "matches" : "MISMATCH"}, body length ${lengthOk ? "matches" : "MISMATCH"}`)
    } catch {
      lines.push("Sidecar present but unreadable")
    }
  } else {
    lines.push("No sidecar file found")
  }
  lines.push(digestOk && sigOk && noTrailingJunk ? "RESULT: VALID" : "RESULT: INVALID")
  return lines.join("\n")
}
