/**
 * Elitza Brain — vertical packs.
 *
 * An industry-specific enablement kit: scout query presets, scoring weights,
 * outreach voice, env-var checklist, and a couple of playbooks. Verticals
 * turn "AI Enabler" from generic into a repeatable, priceable product.
 *
 * Stored under ~/.elitza/verticals/<name>/vertical.json (plus optional
 * playbook .md files). Seeded once; operator edits survive restarts.
 */

import fs from "node:fs"
import path from "node:path"
import { ELITZA_HOME as _ELITZA_HOME } from "./db.js"
import { soulGet, soulSet } from "./soul.js"

export function verticalsDir(): string { return path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "verticals") }

export interface VerticalPack {
  name: string
  description: string
  scout_queries: string[]
  scoring_weights: Record<string, number>
  outreach_voice: string
  env_checklist: string[]
  playbooks: { name: string; content: string }[]
}

const CURATED: VerticalPack[] = [
  {
    name: "farming",
    description: "Agricultural businesses: farms, co-ops, equipment dealers, agronomy consultants, irrigation contractors.",
    scout_queries: [
      "farm irrigation contractor",
      "agricultural equipment dealer",
      "agronomy consultant",
      "farm cooperative",
      "crop spraying service",
    ],
    scoring_weights: { has_website: 10, has_email: 15, rating_over_4: 10, employee_count_visible: 5, recent_activity: 10 },
    outreach_voice: "Practical, no-nonsense, respectful of seasonal rhythms. Lead with time saved during planting/harvest. Avoid hype.",
    env_checklist: ["FARM_LOCATION", "CROP_TYPES", "SEASON_START", "EQUIPMENT_LIST", "WEATHER_API_KEY"],
    playbooks: [
      { name: "farming-diagnosis", content: "# Farming Diagnosis\n\n- What crops/livestock, what acreage\n- Current record-keeping (paper, spreadsheet, software)\n- Seasonal pain points (planting, harvest, compliance)\n- Equipment and connectivity on site\n" },
      { name: "farming-handover", content: "# Farming Handover\n\n- Seasonal calendar and who runs each phase\n- Backup/restore before planting season\n- Offline-first: assume patchy connectivity\n" },
    ],
  },
  {
    name: "trades",
    description: "Trades and field services: plumbers, electricians, HVAC, builders, landscapers.",
    scout_queries: [
      "plumber",
      "electrician",
      "HVAC contractor",
      "builder",
      "landscaper",
    ],
    scoring_weights: { has_website: 10, has_email: 15, rating_over_4: 10, serves_commercial: 10 },
    outreach_voice: "Direct, time-is-money. Lead with missed calls and quote follow-up. Short emails.",
    env_checklist: ["BUSINESS_HOURS", "SERVICE_AREA", "BOOKING_LINK", "REVIEW_LINK"],
    playbooks: [
      { name: "trades-diagnosis", content: "# Trades Diagnosis\n\n- Lead sources and missed-call rate\n- Quoting speed and follow-up\n- Scheduling and dispatch\n- Reviews and referrals\n" },
    ],
  },
]

function packDir(name: string): string {
  return path.join(verticalsDir(), name)
}

function packFile(name: string): string {
  return path.join(packDir(name), "vertical.json")
}

export function listVerticals(): string[] {
  if (!fs.existsSync(verticalsDir())) return []
  return fs.readdirSync(verticalsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(verticalsDir(), e.name, "vertical.json")))
    .map((e) => e.name)
    .sort()
}

export function getVertical(name: string): VerticalPack | null {
  const f = packFile(name)
  if (!fs.existsSync(f)) return null
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as VerticalPack
  } catch {
    return null
  }
}

export function getActiveVertical(): string {
  return soulGet("active_vertical", "").trim()
}

export function setActiveVertical(name: string): boolean {
  if (!getVertical(name)) return false
  soulSet("active_vertical", name)
  return true
}

export function seedVerticals(): string[] {
  fs.mkdirSync(verticalsDir(), { recursive: true })
  const seeded: string[] = []
  for (const pack of CURATED) {
    const dir = packDir(pack.name)
    const file = packFile(pack.name)
    if (fs.existsSync(file)) continue
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(pack, null, 2), { mode: 0o644 })
    // Seed playbooks into brain procedural dir too.
    const procDir = path.join(process.env.ELITZA_HOME ?? _ELITZA_HOME, "brain", "procedural")
    fs.mkdirSync(procDir, { recursive: true })
    for (const pb of pack.playbooks) {
      const pbPath = path.join(procDir, `${pb.name}.md`)
      if (!fs.existsSync(pbPath)) fs.writeFileSync(pbPath, pb.content, { mode: 0o644 })
    }
    seeded.push(pack.name)
  }
  return seeded
}