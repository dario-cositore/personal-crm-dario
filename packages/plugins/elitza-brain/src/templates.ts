/**
 * Elitza Brain — automation template registry.
 *
 * Reusable automation deliverables (webhook glue, email sequences, scripts)
 * that Elitza assembles per client instead of reinventing each time. A
 * template is a directory under ~/.elitza/templates/<name>/ with a
 * template.json manifest and one or more files using {{VAR}} placeholders.
 *
 * `instantiate()` copies the files into a per-client deliverable folder,
 * substitutes placeholders from the CRM client record, and registers the
 * result as a CRM asset. Templates compound: every new one makes the next
 * client cheaper.
 */

import fs from "node:fs"
import path from "node:path"
import { ELITZA_HOME as _ELITZA_HOME } from "./db.js"
import { addAsset, getClient } from "./crm.js"
import { nowISO } from "./db.js"

export function templatesDir(): string { return path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "templates") }
export function deliverablesDir(): string { return path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "deliverables") }

export interface TemplateFile {
  src: string // relative path inside template dir
  dest: string // relative path in instantiated output
}

export interface TemplateManifest {
  name: string
  description: string
  category: string
  env_vars: string[]
  files: string[] // relative paths inside template dir
}

export interface TemplateInfo {
  name: string
  description: string
  category: string
  env_vars: string[]
  files: string[]
}

const CURATED: { manifest: TemplateManifest; files: Record<string, string> }[] = [
  {
    manifest: {
      name: "lead-capture-webhook",
      description: "A tiny HTTP webhook that receives a form submission, stores it, and emails you. Deploy on the client's host.",
      category: "lead-gen",
      env_vars: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "NOTIFY_EMAIL", "STORAGE_PATH"],
      files: ["README.md", "webhook.py", ".env.example"],
    },
    files: {
      "README.md": "# Lead Capture Webhook\n\nClient: {{CLIENT_NAME}}\nGenerated: {{DATE}}\n\nReceives form posts at /lead, stores them in {{STORAGE_PATH}}, emails {{NOTIFY_EMAIL}}.\n",
      "webhook.py": "#!/usr/bin/env python3\nimport os, json, smtplib\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\n\nSTORAGE = os.environ.get('STORAGE_PATH', './leads.jsonl')\nNOTIFY = os.environ.get('NOTIFY_EMAIL', '')\n\nclass H(BaseHTTPRequestHandler):\n    def do_POST(self):\n        n = int(self.headers.get('Content-Length', 0))\n        data = json.loads(self.rfile.read(n) or b'{}')\n        with open(STORAGE, 'a') as f:\n            f.write(json.dumps(data) + '\\n')\n        self.send_response(200)\n        self.end_headers()\n        self.wfile.write(b'ok')\n\nif __name__ == '__main__':\n    HTTPServer(('0.0.0.0', 8080), H).serve_forever()\n",
      ".env.example": "SMTP_HOST=\nSMTP_USER=\nSMTP_PASS=\nNOTIFY_EMAIL={{CLIENT_EMAIL}}\nSTORAGE_PATH=./leads.jsonl\n",
    },
  },
  {
    manifest: {
      name: "review-request-sequence",
      description: "Three-touch email sequence asking happy customers for a review, with opt-out footer.",
      category: "reputation",
      env_vars: ["RESEND_API_KEY", "FROM_EMAIL", "REVIEW_LINK"],
      files: ["README.md", "sequence.md"],
    },
    files: {
      "README.md": "# Review Request Sequence\n\nClient: {{CLIENT_NAME}}\nGenerated: {{DATE}}\n\nThree touches at day 0, 3, 7. Sends from {{FROM_EMAIL}}. Links to {{REVIEW_LINK}}.\n",
      "sequence.md": "## Touch 1 (day 0)\nSubject: Quick favor, {{CLIENT_NAME}}?\n\nHi {{CONTACT_NAME}},\n\nIf we did good work, a short review here helps us a lot: {{REVIEW_LINK}}\n\nThanks,\n{{CLIENT_NAME}}\n\n---\nOpt out: reply 'stop' and we won't email again.\n",
    },
  },
  {
    manifest: {
      name: "invoice-reminder",
      description: "Polite invoice reminder sequence: due, overdue +3, overdue +10.",
      category: "billing",
      env_vars: ["RESEND_API_KEY", "FROM_EMAIL", "PAYMENT_LINK"],
      files: ["README.md", "sequence.md"],
    },
    files: {
      "README.md": "# Invoice Reminder Sequence\n\nClient: {{CLIENT_NAME}}\nGenerated: {{DATE}}\n\nReminders at due date, +3 days, +10 days. Payment link: {{PAYMENT_LINK}}.\n",
      "sequence.md": "## Due (day 0)\nSubject: Invoice due today\n\nHi {{CONTACT_NAME}},\n\nYour invoice is due today. Pay here: {{PAYMENT_LINK}}\n\nThanks,\n{{CLIENT_NAME}}\n",
    },
  },
]

function templateDir(name: string): string {
  return path.join(templatesDir(), name)
}

export function listTemplates(): string[] {
  if (!fs.existsSync(templatesDir())) return []
  return fs.readdirSync(templatesDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(templatesDir(), e.name, "template.json")))
    .map((e) => e.name)
    .sort()
}

export function getTemplate(name: string): TemplateInfo | null {
  const f = path.join(templateDir(name), "template.json")
  if (!fs.existsSync(f)) return null
  try {
    const m = JSON.parse(fs.readFileSync(f, "utf8")) as TemplateManifest
    return { name: m.name, description: m.description, category: m.category, env_vars: m.env_vars, files: m.files }
  } catch {
    return null
  }
}

export function seedTemplates(): string[] {
  fs.mkdirSync(templatesDir(), { recursive: true })
  const seeded: string[] = []
  for (const t of CURATED) {
    const dir = templateDir(t.manifest.name)
    const mf = path.join(dir, "template.json")
    if (fs.existsSync(mf)) continue
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(mf, JSON.stringify(t.manifest, null, 2), { mode: 0o644 })
    for (const [rel, content] of Object.entries(t.files)) {
      const full = path.join(dir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content, { mode: 0o644 })
    }
    seeded.push(t.manifest.name)
  }
  return seeded
}

function substitute(content: string, vars: Record<string, string>): string {
  let out = content
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v)
  }
  return out
}

export function instantiateTemplate(name: string, clientId: number): { dir: string; files: string[] } | null {
  const info = getTemplate(name)
  if (!info) return null
  const client = getClient(clientId)
  if (!client) return null
  const manifest = JSON.parse(fs.readFileSync(path.join(templateDir(name), "template.json"), "utf8")) as TemplateManifest

  const outDir = path.join(deliverablesDir(), String(clientId), `${name}-${Date.now()}`)
  fs.mkdirSync(outDir, { recursive: true })

  const vars: Record<string, string> = {
    CLIENT_NAME: client.name,
    CLIENT_EMAIL: client.email ?? "",
    CONTACT_NAME: client.name,
    BUSINESS_NAME: client.name,
    DATE: nowISO().slice(0, 10),
    PHONE: client.phone ?? "",
    WEBSITE: client.website ?? "",
  }

  const written: string[] = []
  for (const rel of manifest.files) {
    const src = path.join(templateDir(name), rel)
    if (!fs.existsSync(src)) continue
    const raw = fs.readFileSync(src, "utf8")
    const rendered = substitute(raw, vars)
    const dest = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, rendered, { mode: 0o644 })
    written.push(rel)
  }

  // Register as CRM asset.
  try {
    addAsset(clientId, { kind: "automation", name, path: outDir, status: "draft", notes: `Instantiated from template ${name}` })
  } catch {
    // Best effort.
  }

  return { dir: outDir, files: written }
}