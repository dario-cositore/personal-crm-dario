/**
 * Elitza Brain — automation template registry.
 *
 * Reusable automation deliverables (webhook glue, email sequences, scripts)
 * that Elitza assembles per client instead of reinventing each time. A
 * template is a directory under ~/.ai-enablement-agent/templates/<name>/ with a
 * template.json manifest and one or more files using {{VAR}} placeholders.
 *
 * `instantiate()` copies the files into a per-client deliverable folder,
 * substitutes placeholders from the CRM client record, and registers the
 * result as a CRM asset. Templates compound: every new one makes the next
 * client cheaper.
 */

import fs from "node:fs"
import path from "node:path"
import { AI_ENABLEMENT_HOME as _AI_ENABLEMENT_HOME } from "./db.js"
import { addAsset, getClient } from "./crm.js"
import { nowISO } from "./db.js"

export function templatesDir(): string { return path.join((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) ?? _AI_ENABLEMENT_HOME, "templates") }
export function deliverablesDir(): string { return path.join((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) ?? _AI_ENABLEMENT_HOME, "deliverables") }

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
  {
    manifest: {
      name: "backlink-outreach-pack",
      description: "Backlink acquisition SOP for dariocositore.com: expert citation, guest post, directory pitch, broken link, and unlinked-mention templates with link magnets, UTM protocol, rejection logic tree, and daily outreach routine.",
      category: "seo",
      env_vars: ["RESEND_API_KEY", "RESEND_FROM", "OUTREACH_SIGNATURE"],
      files: ["README.md", "templates.md", "link-magnets.md", "utm-protocol.md", "rejection-tree.md", "daily-routine.md"],
    },
    files: {
      "README.md": "# Backlink Outreach Pack\n\nClient: {{CLIENT_NAME}}\nGenerated: {{DATE}}\n\nThis pack contains the backlink acquisition SOP for dariocositore.com. It is NOT per-client outreach — it is the playbook for promoting dariocositore.com itself through expert citations, guest posts, directory submissions, broken link building, and unlinked mention reclamation.\n\nSender: Dario Cositore <dario@mail.dariocositore.com> (verified Resend subdomain — primary domain stays clean for transactional/notifications)\nOutreach signature: {{OUTREACH_SIGNATURE}}\n\nFiles:\n- templates.md — 6 ready-to-send email templates\n- link-magnets.md — which pages to promote and why\n- utm-protocol.md — UTM tagging convention for all controlled links\n- rejection-tree.md — if/then logic for rejected pitches\n- daily-routine.md — daily outreach engine (2 hours/day)\n",
      "templates.md": "## Template 1 — Expert citation (Featured / Qwoted / journalist pitch)\n\nSubject: Expert Data: [Specific Trend] // Insight from Dario Cositore\n\nHi [Journalist Name],\n\nI saw your recent piece on [Topic]. We've noticed a [Percentage]% shift in [metric] for [Topic] over the last month in our GA4 data, suggesting [Insight].\n\nOur founder, Dario Cositore, is available for a 2-sentence quote on how this trend impacts businesses in 2026.\n\nBest,\n[Your Name]\n\n---\n\n## Template 2 — Guest post pitch\n\nSubject: Guest post idea: [Title] for [Site Name]\n\nHi [Editor Name],\n\nI'm Dario Cositore, an AI enablement and operations leader working with law firms, agencies and growth teams across Europe. I build production agentic systems with approval gates, model evaluation and handover, not pilots.\n\nI'd like to pitch a post for [Site Name]:\n\nTitle: [Proposed title]\nAngle: [One sentence on what the post argues and why it matters to your readers]\nLength: ~1,200 words, no fluff, with one concrete case study and a checklist.\nWhy me: I've rebuilt CRM/intake pipelines for a 30-person law firm (+45% qualified conversions, 10s lead-to-CRM sync) and benchmarked 13 pre-release frontier models. I can write from shipped work, not theory.\n\nSample of my writing: https://dariocositore.com/blog/[relevant-post]/\n\nIf this fits your editorial calendar, I can have a draft in 2 weeks.\n\nBest,\nDario Cositore\nhttps://dariocositore.com/\n\n---\n\n## Template 3 — Directory / resource pitch (AI Visibility Checklist)\n\nSubject: Free resource for your readers: 29-point AI visibility checklist\n\nHi [Name],\n\nI published a free, no-email-gate AI visibility checklist for [law firm / agency / ops] sites: 29 checks covering AI crawler access, structured data, canonical hygiene, quotable content, trust and measurement.\n\nIt's here: https://dariocositore.com/tools/ai-visibility-checklist/\n\nIf it's useful to your readers, feel free to link it. No gate, no pitch, no follow-up.\n\nOne-sentence version for newsletters/social: \"I published a 29-point AI visibility checklist for law firm sites, free to link, no email required.\"\n\nBest,\nDario Cositore\n\n---\n\n## Template 4 — Unlinked mention reclamation\n\nSubject: Quick ask: link to dariocositore.com?\n\nHi [Name],\n\nThanks for mentioning Dario Cositore in your piece on [Topic] ([URL]). Glad it was useful.\n\nWould you be open to linking the mention to https://dariocositore.com/? It helps readers find the source and it's the canonical home for his work.\n\nHappy to return the favor if there's anything I can contribute to a future piece.\n\nBest,\nDario Cositore\n\n---\n\n## Template 5 — Follow-up (send once, 7-14 days after first pitch)\n\nSubject: Re: [original subject]\n\nHi [Name],\n\nBumping this in case it got buried. Happy to adjust the angle or send a shorter version if that helps.\n\nBest,\nDario Cositore\n\n---\n\n## Template 6 — Broken link building\n\nSubject: Broken link on [Page Title] — replacement suggestion\n\nHi [Editor Name],\n\nI was reading your [Page Title] resource page ([URL]) and noticed the link to [Broken Target] is returning a 404.\n\nI recently published a similar resource that might work as a replacement: [Magnet URL] — [one sentence on what it covers and why it fits your list].\n\nIf it's useful, feel free to swap it in. If not, no worries — just flagging the dead link so your readers don't hit a wall.\n\nBest,\nDario Cositore\nhttps://dariocositore.com/\n",
      "link-magnets.md": "## Link Magnets (promote these, not every page)\n\nBased on GA4 engagement data (90-day window). Promote these URLs in outreach.\n\n| Magnet | URL | Why editors link to it |\n|---|---|---|\n| Top magnet | /how-to/make-money-with-ai-agents/ | Highest Average Engagement Time (52s) |\n| Utility magnet | /free/ | 100% engagement rate |\n| Utility magnet | /how-to/build-ai-social-media-agent/ | 100% engagement rate |\n| Secondary | /how-to/ai-agent-profiles-for-freelancers/ | 100% engagement rate |\n| Secondary | /tools/youtube-comments-off/ | 100% engagement rate |\n| Diagnostic (soft CTA) | /diagnostics/ | Free, no gate, Dario reads every brief |\n\nRule: in every guest-post pitch and broken-link email, offer one of the top two magnets as the replacement or resource link. Do not promote the homepage.\n",
      "utm-protocol.md": "## UTM Protocol\n\nAll agent-controlled links must use: ?utm_source=[domain]&utm_medium=referral&utm_campaign=link_building_q4_26\n\nExamples:\n- Guest post author bio: ?utm_source=forbes&utm_medium=referral&utm_campaign=link_building_q4_26\n- Directory profile: ?utm_source=taaft&utm_medium=directory&utm_campaign=link_building_q4_26\n- Broken link replacement: ?utm_source=<site>&utm_medium=referral&utm_campaign=link_building_q4_26\n- Social bio (LinkedIn): ?utm_source=linkedin&utm_medium=social&utm_campaign=entity_setup_nov26\n- Email signature: ?utm_source=email&utm_medium=email&utm_campaign=signature\n\nRules: lowercase everything, no spaces (use underscores). Never change a UTM on a live link after publishing.\n",
      "rejection-tree.md": "## Rejection Logic Tree\n\nIf \"No guest posts allowed\": Pivot to Digital PR. Ask: \"Can I provide an expert quote for an upcoming article you are already writing?\" (Use Template 1.)\n\nIf \"We charge a fee\": Decline the fee and pivot to Value Swap. Offer to create a custom infographic or provide original data that makes their existing page better. No paid placements.\n\nIf \"Not a fit\": Ask for clarification on their 2026 editorial focus. Use the feedback to pitch a more relevant link magnet in 3 months. Log the rejection reason.\n",
      "daily-routine.md": "## Daily Outreach Engine (2 hours/day)\n\n- Prospect Discovery (30 min): Run footprint search strings, add 10 new high-DA targets to Link CRM.\n- Expert Citations (15 min): Check Qwoted/Featured for Marketing/Tech requests. Draft 2 pitches using Template 1.\n- Engagement (15 min): Social warming on LinkedIn — follow and engage with editors you plan to pitch next week.\n- Outreach (1 hour): Send 5-10 personalized pitches for link magnets or broken link building.\n\nRules: never pitch the same site twice in 6 months. Prioritize DA >= 30. Skip content farms, PBNs, paid guest post sites.\n",
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