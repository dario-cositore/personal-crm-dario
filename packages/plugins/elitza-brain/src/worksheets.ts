/**
 * Elitza Brain — interactive worksheet library (internal CRM asset).
 *
 * The worksheets are the empty, fillable templates that ship with the
 * operator's products: the method lives on the page, the empty rows are the
 * download. Inside the CRM they are never gated behind an email — they are
 * pulled straight into a client's record when a case calls for them, so the
 * operator opens them on a call or before one.
 *
 * Catalog: a static list of the bundled worksheets with tags, verticals and
 * the stages where each earns its keep. Matching is keyword + vertical based,
 * so a legal client with a CRM pain gets the CRM repair kit, not the OCR pack.
 *
 * Storage:
 *   - bundled copies live next to this module (packages/.../worksheets)
 *   - on load they are seeded into ~/.ai-enablement-agent/brain/worksheets (never overwriting)
 *   - a "pull" copies the seeded file into the client's pipeline folder and
 *     attaches it as a client_asset of kind "worksheet".
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BRAIN_DIR, AI_ENABLEMENT_HOME, nowISO } from "./db.js"
import { addAsset, getClient, listAssets, logInteraction, firstConfiguredStage, type Client } from "./crm.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BUNDLED_WORKSHEETS_DIR = path.join(HERE, "..", "worksheets")
export const WORKSHEET_DIR = process.env.ELITZA_WORKSHEETS_DIR || path.join(BRAIN_DIR, "worksheets")

export interface Worksheet {
  id: string
  file: string
  title: string
  description: string
  tags: string[]
  verticals: string[]
  stages: string[]
}

export const WORKSHEETS: Worksheet[] = [
  { id: "agent-profile-bundle", file: "agent-profile-bundle.html", title: "Five Agent Profiles You Can Install This Afternoon", description: "Installable agent profiles plus the build kit: role card, tool registry, memory schema.", tags: ["ai-agents", "profiles", "ops", "agent"], verticals: ["ai", "consulting", "ops", "automation"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "agent-stack", file: "agent-stack.html", title: "Agent Stack", description: "Operator plus operators in one workbook: five profiles, one role card, one tool registry, one memory schema.", tags: ["ai-agents", "stack", "ops", "agent"], verticals: ["ai", "consulting", "ops", "automation"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "ai-systems-architect-spec-pack", file: "ai-systems-architect-spec-pack.html", title: "AI Systems Architect Spec", description: "What to write before you build: scope, approval gates, data path, milestones, fixed price quote.", tags: ["spec", "architecture", "proposal", "ai", "scope"], verticals: ["ai", "consulting", "software", "automation"], stages: ["proposal", "scheduled"] },
  { id: "ai-workflow-audit-kit", file: "ai-workflow-audit-kit.html", title: "Workflow Audit Kit", description: "Find the break in a workflow in one sitting: inventory, failure signals, scoring, scoped rebuild.", tags: ["audit", "workflow", "diagnosis", "ops", "break"], verticals: ["ops", "consulting", "automation", "ai"], stages: ["diagnose", "scouted"] },
  { id: "automated-lead-routing-kit", file: "automated-lead-routing-kit.html", title: "Automated Lead Routing Kit", description: "Routing contract, priority order, decision object, owner validation, failure queue, audit trail.", tags: ["lead-routing", "routing", "sales", "crm", "automation", "leads"], verticals: ["sales", "marketing", "crm", "automation", "lead-gen"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "business-ai-agent-build-kit", file: "business-ai-agent-build-kit.html", title: "Business AI Agent Build Kit", description: "Build an auditable business AI agent: role card, tool registry, memory schema, recovery, handover.", tags: ["ai-agent", "build", "audit", "compliance", "agent"], verticals: ["ai", "consulting", "automation"], stages: ["proposal", "workbook", "scheduled"] },
  { id: "clio-manage-to-hubspot-sync", file: "clio-manage-to-hubspot-sync.html", title: "Clio Manage to HubSpot Sync", description: "Legal CRM sync mapped field by field: source of truth, dedupe, retries, rate limits, trial run.", tags: ["legal", "crm", "sync", "integration", "hubspot", "clio"], verticals: ["legal", "law", "crm", "automation"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "contract-ocr-api-pack", file: "contract-ocr-api-pack.html", title: "Contract OCR API Pack", description: "Clean JSON out of messy PDFs: extraction prompt, schema, validation, human escalation.", tags: ["documents", "ocr", "api", "extraction", "contracts", "pdf"], verticals: ["legal", "finance", "ops", "automation", "document-processing"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "crm-automation-repair-kit", file: "crm-automation-repair-kit.html", title: "CRM Automation Repair Kit", description: "Dedupe, merge rules, routing reasons, SLA timers, audit trail for a broken CRM.", tags: ["crm", "repair", "dedupe", "routing", "sla", "automation"], verticals: ["crm", "sales", "ops", "automation"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "law-firm-stack", file: "law-firm-stack.html", title: "Law Firm Stack", description: "MyCase intake plus contract extraction in one workbook: field map, conflict checks, SLA, extraction schema.", tags: ["legal", "intake", "documents", "stack", "law-firm"], verticals: ["legal", "law", "automation", "document-processing"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "mycase-lead-intake-kit", file: "mycase-lead-intake-kit.html", title: "MyCase Lead Intake Kit", description: "Automate legal intake from form to matter: field map, conflict checks, approval gate, SLA timer.", tags: ["legal", "intake", "lead", "crm", "mycase"], verticals: ["legal", "law", "lead-gen", "automation"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "ops-rebuild-stack", file: "ops-rebuild-stack.html", title: "Ops Rebuild Stack", description: "Diagnosis plus repair in one workbook: workflow audit and CRM repair kit.", tags: ["ops", "rebuild", "audit", "crm", "repair"], verticals: ["ops", "consulting", "automation"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "routing-stack", file: "routing-stack.html", title: "Routing Stack", description: "Speed-to-lead pipeline and routing layer in one workbook sharing one event contract.", tags: ["routing", "lead", "speed-to-lead", "automation", "stack"], verticals: ["sales", "marketing", "lead-gen", "automation"], stages: ["diagnose", "proposal", "workbook"] },
  { id: "speed-to-lead-blueprint-pack", file: "speed-to-lead-blueprint-pack.html", title: "Speed-to-Lead Blueprint Pack", description: "Seven stage pipeline, Make.com outline, latency budget, alert thresholds, rollout plan.", tags: ["speed-to-lead", "lead", "routing", "blueprint", "pipeline"], verticals: ["sales", "marketing", "lead-gen", "automation"], stages: ["diagnose", "proposal", "workbook", "scheduled"] },
]

/** Seed bundled worksheets into the brain worksheets folder. Never overwrites. */
export function ensureWorksheets(): string[] {
  fs.mkdirSync(WORKSHEET_DIR, { recursive: true })
  const written: string[] = []
  if (!fs.existsSync(BUNDLED_WORKSHEETS_DIR)) return written
  for (const w of WORKSHEETS) {
    const src = path.join(BUNDLED_WORKSHEETS_DIR, w.file)
    const dst = path.join(WORKSHEET_DIR, w.file)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(dst)) continue
    fs.copyFileSync(src, dst)
    written.push(dst)
  }
  return written
}

export function worksheetPath(w: Worksheet): string {
  return path.join(WORKSHEET_DIR, w.file)
}

export function listWorksheets(): (Worksheet & { available: boolean; path: string })[] {
  ensureWorksheets()
  return WORKSHEETS.map((w) => {
    const p = worksheetPath(w)
    return { ...w, available: fs.existsSync(p), path: p }
  })
}

function textBlob(client: Client): string {
  return [
    client.name,
    client.vertical,
    client.notes,
    client.tech_stack,
    client.risk_notes,
    client.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

/** Score a worksheet against a client. Higher = better fit. */
export function scoreWorksheet(client: Client, w: Worksheet): number {
  const blob = textBlob(client)
  let score = 0
  for (const tag of w.tags) {
    if (blob.includes(tag.toLowerCase().replace(/-/g, " "))) score += 3
    if (blob.includes(tag.toLowerCase())) score += 2
  }
  for (const v of w.verticals) {
    if ((client.vertical ?? "").toLowerCase().includes(v)) score += 4
    if (blob.includes(v)) score += 1
  }
  // stage weighting: a worksheet earns more if its stages include the client's stage
  if (w.stages.includes(client.status)) score += 5
  // legal boost
  if (/(legal|law|attorney|studio legale)/i.test(blob) && w.verticals.includes("legal")) score += 6
  // lead/sales boost
  if (/(lead|routing|speed|sales|crm)/i.test(blob) && (w.tags.includes("lead-routing") || w.tags.includes("routing") || w.tags.includes("crm"))) score += 4
  // document/ocr boost
  if (/(document|ocr|pdf|contract|fascicol)/i.test(blob) && (w.tags.includes("documents") || w.tags.includes("ocr"))) score += 4
  // audit/diagnosis boost for early stages
  const firstStage = firstConfiguredStage()
  if ((client.status === firstStage || client.status === "scouted" || client.status === "diagnose") && w.tags.includes("audit")) score += 3
  return score
}

export function recommendWorksheets(client: Client, limit = 3): Worksheet[] {
  const scored = WORKSHEETS.map((w) => ({ w, score: scoreWorksheet(client, w) }))
  scored.sort((a, b) => b.score - a.score || a.w.title.localeCompare(b.w.title))
  return scored.slice(0, Math.max(1, limit)).map((s) => s.w)
}

export interface PullResult {
  worksheet: Worksheet
  path: string
  asset_id: number
}

/** Copy a worksheet into the client's pipeline folder and attach it as an asset. */
export function pullWorksheet(clientId: number, worksheetId: string): PullResult {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const w = WORKSHEETS.find((x) => x.id === worksheetId)
  if (!w) throw new Error(`Unknown worksheet "${worksheetId}".`)
  ensureWorksheets()
  const src = worksheetPath(w)
  if (!fs.existsSync(src)) throw new Error(`Worksheet file missing on disk: ${src}`)

  const stamp = new Date().toISOString().slice(0, 10)
  const dir = path.join(AI_ENABLEMENT_HOME, "pipeline", stamp)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `C${clientId}-worksheet-${w.id}.html`)
  fs.copyFileSync(src, dest)

  const asset = addAsset(clientId, {
    kind: "worksheet",
    name: `Worksheet: ${w.title}`,
    path: dest,
    status: "pulled",
    notes: `Pulled for ${client.name} (${client.status})`,
  })
  logWorksheetInteraction(clientId, w, dest)
  return { worksheet: w, path: dest, asset_id: asset.id }
}

function logWorksheetInteraction(clientId: number, w: Worksheet, dest: string): void {
  try {
    logInteraction(clientId, {
      kind: "worksheet",
      direction: "note",
      channel: "crm",
      status: "pulled",
      subject: `worksheet: ${w.title}`,
      body: `Pulled ${w.file} → ${dest}`,
      occurred_at: nowISO(),
    })
  } catch {
    // best-effort
  }
}

/** Convenience: pull the top recommended worksheet for a client (used at enrichment). */
export function pullRecommendedWorksheet(clientId: number, limit = 1): PullResult[] {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const recs = recommendWorksheets(client, limit)
  const out: PullResult[] = []
  for (const w of recs) {
    try {
      out.push(pullWorksheet(clientId, w.id))
    } catch {
      // skip unavailable
    }
  }
  return out
}

/** Has this client already had this worksheet pulled? */
export function alreadyPulled(clientId: number, worksheetId: string): boolean {
  const assets = listAssets(clientId)
  const w = WORKSHEETS.find((x) => x.id === worksheetId)
  if (!w) return false
  return assets.some((a) => a.kind === "worksheet" && a.name === `Worksheet: ${w.title}`)
}
