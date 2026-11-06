/**
 * Elitza Brain — tools.
 *
 * 1:1 port of the full tool surface of legacy `tools/brain_tools.py`,
 * registered through the Elitza plugin tool registry so Elitza can
 * interact with her own mind:
 *   brain_search, brain_create, brain_stats, brain_consolidate,
 *   brain_forget, brain_personality, brain_metamemory,
 *   brain_learning, brain_persistence, brain_search_history, brain_sessions,
 *   brain_config, brain_validate, doctor_check, doctor_repair, doctor_history
 */

import { doctorCheck, doctorHistory, doctorRepair } from "./doctor.js"

import { configSection, validateConfig } from "./configview.js"
import { ensureKnowledge, readPlaybook } from "./knowledge.js"
import path from "node:path"
import { generateHandover, verifyHandover } from "./handover.js"
import { listVerticals, getVertical, getActiveVertical, setActiveVertical, seedVerticals } from "./verticals.js"
import { ELITZA_HOME } from "./db.js"
import { getPersonality } from "./soul.js"
import { issue, verifyToken, delegate, revoke, listIssued, listRevoked, covers, attachSession, detachSession, getSessionCapability } from "./capability.js"
import { addTrigger, listTriggers, setTriggerStatus, deleteTrigger, processTriggers } from "./crm.js"
import { setCustomField, getCustomFields, deleteCustomField, addDeal, updateDeal, listDeals, deleteDeal, addTag, removeTag, listTags, allTags, logAudit, listAudit, costSummary, exportClientsCSV, importClientsCSV, connectCloud, disconnectCloud, listCloudAccounts, continuousBackupStream, uploadBackupToCloud, revenueStats, weeklyDigest } from "./crm.js"
import { listTemplates, getTemplate, seedTemplates, instantiateTemplate } from "./templates.js"
import {
  getMetamemory,
  listProceduralSkills,
  memoryConsolidate,
  memoryCreate,
  memoryForget,
  memorySearch,
  memoryStats,
  getLearningStats,
} from "./memory.js"
import { pollPipeline, querySignals } from "./pipeline.js"
import {
  addAsset,
  addClient,
  CLIENT_STATUSES,
  findClients,
  getClient,
  listAssets,
  listInteractions,
  logInteraction,
  updateClient,
  type ClientPatch,
} from "./crm.js"
import { scoutBusinesses, discoverEmail } from "./scouting.js"
import { enrichClient } from "./enrichment.js"
import { listWorksheets, recommendWorksheets, pullWorksheet, alreadyPulled, type Worksheet } from "./worksheets.js"
import {
  addToPipeline,
  approveDrafts,
  dispose,
  listDue,
  listPipeline,
  queueFollowups,
  sendApproved,
  sweepExhausted,
  variantStats,
  writeDraft,
} from "./outreach.js"
import {
  advance,
  NEXT_ACTIONS,
  productionState,
  PRODUCTION_STAGES,
  recordPayment,
  scheduleCall,
} from "./production.js"
import { persistenceStats, recentSessions, searchMessages } from "./sessions.js"
import {
  abandonTask,
  blockTask,
  createTask,
  describeTask,
  doneTask,
  listTasks,
  renameTask,
  startTask,
  unblockTask,
  type TaskStatus,
} from "./tasks.js"

// The promise-API tool shape: execute returns a Promise.
export interface BrainToolInfo {
  name: string
  description: string
  input: { type: "object"; properties: Record<string, unknown>; required?: string[] }
  execute: (
    input: Record<string, any>,
    ctx?: { sessionID?: string },
  ) => Promise<{ content: string }>
  options?: { codemode: boolean }
}

export function makeBrainTools(ctx?: { generate: { text: (input: { prompt: string }) => Promise<{ data: { text: string } }> } }): BrainToolInfo[] {
  const tools: BrainToolInfo[] = [
    {
      name: "brain_search",
      description:
        "Search your memories and knowledge. Use this to recall past interactions, facts, skills, or emotional experiences.",
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (what you want to remember)",
          },
          memory_type: {
            type: "string",
            enum: ["episodic", "semantic", "procedural", "emotional"],
            description: "Filter by memory type (optional)",
          },
          limit: {
            type: "integer",
            description: "Max results (default 10)",
            default: 10,
          },
        },
        required: ["query"],
      },
      execute: async (input) => ({
        content: memorySearch(input.query, input.memory_type, input.limit ?? 10),
      }),
    },
    {
      name: "brain_create",
      description:
        "Create a new memory. Use this to explicitly store important information you want to remember.",
      input: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory content to store",
          },
          memory_type: {
            type: "string",
            enum: ["episodic", "semantic", "procedural", "emotional"],
            description: "Type of memory (default: episodic)",
          },
          importance: {
            type: "number",
            description: "Importance 0.0-1.0 (default 0.7)",
            default: 0.7,
          },
          tags: {
            type: "string",
            description: "Comma-separated tags for categorization",
          },
        },
        required: ["content"],
      },
      execute: async (input) => {
        const tags: string[] = input.tags
          ? String(input.tags)
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : []
        return {
          content: memoryCreate(
            input.content,
            { memoryType: input.memory_type ?? "episodic", importance: input.importance ?? 0.7, tags },
          ),
        }
      },
    },
    {
      name: "brain_stats",
      description: "View your brain statistics, memory counts, and current personality state.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: memoryStats() }),
    },
    {
      name: "brain_consolidate",
      description:
        "Run memory consolidation. This promotes important episodic memories to lasting semantic knowledge.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: memoryConsolidate() }),
    },
    {
      name: "brain_forget",
      description: "Forget memories matching a query. Use this to remove outdated or incorrect information.",
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to forget",
          },
        },
        required: ["query"],
      },
      execute: async (input) => ({ content: memoryForget(input.query) }),
    },
    {
      name: "brain_personality",
      description: "View your current personality, mood, confidence, and emotional state.",
      input: { type: "object", properties: {} },
      execute: async () => {
        const p = getPersonality()
        return {
          content: JSON.stringify(
            {
              name: p.name,
              mood: p.mood,
              confidence: p.confidence,
              interactions: p.interactions,
              style: p.style,
              emotional_state: p.emotional_state ?? {},
              top_tools: Object.entries(p.preferences ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5),
              recent_learnings: (p.learnings ?? []).slice(-3),
            },
            null,
            2,
          ),
        }
      },
    },
    {
      name: "brain_metamemory",
      description:
        "View metamemory statistics - how your memory system is performing, recall patterns, and most accessed memories.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: JSON.stringify(getMetamemory(), null, 2) }),
    },
    {
      name: "brain_learning",
      description:
        "View auto-learning statistics - how many skills, knowledge items, and lessons have been extracted from conversations.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: JSON.stringify(getLearningStats(), null, 2) }),
    },
    {
      name: "brain_persistence",
      description: "View persistence statistics - how many messages and sessions are stored permanently.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: JSON.stringify(persistenceStats(), null, 2) }),
    },
    {
      name: "brain_search_history",
      description: "Search across ALL past conversations to find relevant context.",
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in conversation history",
          },
          limit: {
            type: "integer",
            description: "Max results (default 10)",
            default: 10,
          },
        },
        required: ["query"],
      },
      execute: async (input) => ({
        content: searchMessages(input.query, input.limit ?? 10),
      }),
    },
    {
      name: "brain_sessions",
      description: "View recent conversation sessions.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: recentSessions(10) }),
    },
    {
      name: "brain_config",
      description:
        "View Elitza's configuration. Pass a section name (e.g., 'model', 'brain', 'personality') to see specific settings, or leave empty for full summary.",
      input: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description: "Config section to view (e.g., 'model', 'brain', 'personality', 'tools')",
          },
        },
      },
      execute: async (input) => ({
        content: configSection(input.section ?? "", tools.map((t) => t.name)),
      }),
    },
    {
      name: "brain_validate",
      description: "Validate Elitza's configuration and show any warnings or issues.",
      input: { type: "object", properties: {} },
      execute: async () => {
        const warnings = validateConfig()
        if (warnings.length === 0) return { content: "Configuration is valid. No warnings." }
        return {
          content: [`Configuration warnings (${warnings.length}):`, ...warnings.map((w) => `- ${w}`)].join("\n"),
        }
      },
    },
    {
      name: "doctor_check",
      description:
        "Run a full health check on all Elitza subsystems (databases, brain, config, tools, plugins, hooks, disk space).",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: doctorCheck(tools.map((t) => t.name)) }),
    },
    {
      name: "doctor_repair",
      description: "Attempt to automatically repair any detected issues with Elitza's subsystems.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: doctorRepair() }),
    },
    {
      name: "doctor_history",
      description: "View health check history over the past week.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: doctorHistory(7) }),
    },
    {
      name: "gapfeed_query_signals",
      description:
        "Scan the local gapfeed radar for real-time buyer-intent signals: fresh pain points and operational bottlenecks from the market feed. Reads the LOCAL gapfeed backend (127.0.0.1:5002, overridable with GAPFEED_LOCAL_URL) — returns an empty result when that server is not running. region filters client-side against each signal's location, so locations without a country do not match italy/eu.",
      input: {
        type: "object",
        properties: {
          vertical: {
            type: "string",
            description: "Filter by vertical, e.g. legal_tech, crm_ops, logistics (optional)",
          },
          region: {
            type: "string",
            enum: ["italy", "eu", "global"],
            description: "Filter by signal location (default: global)",
          },
          urgency_threshold: {
            type: "number",
            description: "Minimum urgency 0-1 (default 0)",
          },
          quality_tier: {
            type: "string",
            enum: ["gold", "silver", "bronze", "noise"],
            description: "Exact quality tier filter (optional)",
          },
          limit: {
            type: "integer",
            description: "Max signals to return, 1-500 (default 50)",
          },
        },
      },
      execute: async (input) => {
        const signals = await querySignals({
          vertical: input.vertical ? String(input.vertical) : undefined,
          region: (input.region as "italy" | "eu" | "global" | undefined) ?? "global",
          urgency_threshold: Number(input.urgency_threshold ?? 0),
          quality_tier: input.quality_tier ? String(input.quality_tier) : undefined,
          limit: Number(input.limit ?? 50),
        })
        if (!signals.length) {
          return {
            content:
              "No signals matched (or the local gapfeed server is not running — start it with: cd gapfeed && .venv/bin/python -m ui.server)",
          }
        }
        return { content: JSON.stringify({ count: signals.length, signals }, null, 2) }
      },
    },
    {
      name: "gapfeed_build_pipeline",
      description:
        "Run the outreach pipeline immediately: pull recent high-urgency signals from the local gapfeed radar and write a markdown outreach draft for each one not already drafted, into ~/.elitza/pipeline/<date>/. Never sends anything — drafts wait for a human read. Bypasses the 6-hour heartbeat interval.",
      input: { type: "object", properties: {} },
      execute: async () => {
        const result = await pollPipeline({ force: true })
        if (!result) return { content: "The pipeline is disabled (ELITZA_GAPFEED=0)." }
        if (!result.fetched) {
          return {
            content:
              "No signals above the draft threshold — or the local gapfeed server is not running (start it with: cd gapfeed && .venv/bin/python -m ui.server)",
          }
        }
        if (!result.drafted.length) return { content: `Fetched ${result.fetched} signal(s); all already drafted (${result.skipped} skipped).` }
        return {
          content: [
            `Fetched ${result.fetched} signal(s); wrote ${result.drafted.length} new draft(s), skipped ${result.skipped} already-drafted.`,
            "",
            ...result.drafted,
            "",
            "Review each draft before anything goes out — the pipeline never sends.",
          ].join("\n"),
        }
      },
    },
    {
      name: "client_scout",
      description:
        "Scout local businesses for AI enablement outreach: a location plus a query returns name, address, phone, website, rating, review count, category and map link. Free OpenStreetMap (Overpass) carries the search; Google Places runs only as an optional fallback when GOOGLE_MAPS_API_KEY is set — no key is embedded anywhere. Queries: idraulici, parrucchieri, dentisti, avvocati, commercialisti, ristoranti, bar, autofficine, farmacie (English words work too). Read-only: it never stores, ranks, or contacts anyone.",
      input: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "Where to search, e.g. 'Castelleone, Cremona, Italy'",
          },
          query: {
            type: "string",
            description: "What to look for, e.g. 'dentisti', 'parrucchieri', 'idraulici', 'ristoranti', 'bar'",
          },
          limit: {
            type: "integer",
            description: "Max businesses to return, 1-20 (default 10)",
            default: 10,
          },
        },
        required: ["location", "query"],
      },
      execute: async (input) => {
        const location = String(input.location ?? "").trim()
        const query = String(input.query ?? "").trim()
        if (!location || !query) return { content: "client_scout needs both a location and a query." }
        const result = await scoutBusinesses(location, query, Number(input.limit ?? 10))
        if (result.error) return { content: result.error }
        if (!result.businesses.length) return { content: `No businesses matched "${query}" in ${location}.` }
        return {
          content: JSON.stringify(
            { count: result.businesses.length, businesses: result.businesses, meta: result.meta },
            null,
            2,
          ),
        }
      },
    },
    {
      name: "crm",
      description:
        "Run the AI Enablement CRM: client records, touches, and documents. Operations: add (name required; vertical, status, score 0-100, address, phone, website, email, rating, rating_count, category, source, notes, deal_value in euros, next_action, next_action_at optional — an existing website or name+address returns the row already in the CRM), search (query, status, limit), get (id), update (id plus any of those client fields), log (id, kind, plus direction, channel, status, subject, body — also moves the client's last_contact), interactions (id), asset (id, kind, name, plus path, status, notes), assets (id). Statuses: " +
        CLIENT_STATUSES.join(", ") +
        ". Records only — nothing here contacts anyone (find_email only reads the client's own public website).",
      input: {
        type: "object",
        properties: {
          operation: {
            type: "object",
            description: "The CRM operation to perform.",
            properties: {
              action: {
                type: "string",
                enum: ["add", "search", "get", "update", "log", "interactions", "asset", "assets", "find_email", "custom_field", "deal", "tag", "audit", "tags"],
                description: "Which operation to run.",
              },
              id: { type: "integer", description: "Client id, for every operation except add and search." },
              name: { type: "string", description: "Client name (required for add)." },
              query: { type: "string", description: "Text to match for search (name, vertical, website, notes)." },
              status: { type: "string", description: "Pipeline status, or filter for search." },
              limit: { type: "integer", description: "Max rows for search (default 50)." },
              vertical: { type: "string", description: "Industry or niche, e.g. dental, legal, logistics." },
              score: { type: "integer", description: "Qualification score 0-100." },
              address: { type: "string" },
              phone: { type: "string" },
              website: { type: "string" },
              email: { type: "string" },
              linkedin: { type: "string", description: "LinkedIn profile URL." },
              twitter: { type: "string", description: "X/Twitter profile URL." },
              facebook: { type: "string", description: "Facebook page URL." },
              instagram: { type: "string", description: "Instagram profile URL." },
              language: { type: "string", description: "Client document language: 'en' or 'it'. Controls which playbooks/documents are pulled." },
              notes: { type: "string" },
              deal_value: { type: "integer", description: "Deal value in whole euros." },
              next_action: { type: "string", description: "What has to happen next with this client." },
              next_action_at: { type: "string", description: "ISO date the next action is due." },
              source: { type: "string", description: "Where the client came from: places, gapfeed, manual." },
              kind: { type: "string", description: "Interaction or asset kind, e.g. first_touch, reply, proposal, workbook." },
              direction: { type: "string", description: "Interaction direction: out, in, note." },
              channel: { type: "string", description: "Interaction channel: email, linkedin, whatsapp, phone, note." },
              subject: { type: "string" },
              body: { type: "string" },
              path: { type: "string", description: "File path for an asset." },
              key: { type: "string", description: "Custom field key (custom_field)." },
              value: { type: "string", description: "Custom field value (custom_field)." },
              title: { type: "string", description: "Deal title (deal)." },
              deal_value2: { type: "integer", description: "Deal value in euros (deal)." },
              probability: { type: "integer", description: "Deal probability 0-100 (deal)." },
              close_date: { type: "string", description: "Deal close date ISO (deal)." },
              tag: { type: "string", description: "Tag name (tag)." },
              deal_id: { type: "integer", description: "Deal id (deal update/delete)." },
              entity: { type: "string", description: "Audit entity filter." },
            },
            required: ["action"],
          },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        const op = (input.operation ?? {}) as Record<string, any>
        const action = String(op.action ?? "")
        const clientID = () => Number(op.id)
        try {
          switch (action) {
            case "add": {
              const { client, created } = addClient({
                name: String(op.name ?? ""),
                vertical: op.vertical !== undefined ? String(op.vertical) : undefined,
                status: op.status !== undefined ? String(op.status) : undefined,
                score: op.score !== undefined ? Number(op.score) : undefined,
                address: op.address !== undefined ? String(op.address) : undefined,
                phone: op.phone !== undefined ? String(op.phone) : undefined,
                website: op.website !== undefined ? String(op.website) : undefined,
                email: op.email !== undefined ? String(op.email) : undefined,
                notes: op.notes !== undefined ? String(op.notes) : undefined,
                deal_value: op.deal_value !== undefined ? Number(op.deal_value) : undefined,
                source: op.source !== undefined ? String(op.source) : undefined,
                next_action: op.next_action !== undefined ? String(op.next_action) : undefined,
                next_action_at: op.next_action_at !== undefined ? String(op.next_action_at) : undefined,
                linkedin: op.linkedin !== undefined ? String(op.linkedin) : undefined,
                twitter: op.twitter !== undefined ? String(op.twitter) : undefined,
                facebook: op.facebook !== undefined ? String(op.facebook) : undefined,
                instagram: op.instagram !== undefined ? String(op.instagram) : undefined,
                risk_level: op.risk_level !== undefined ? String(op.risk_level) : undefined,
                risk_score: op.risk_score !== undefined ? Number(op.risk_score) : undefined,
                risk_notes: op.risk_notes !== undefined ? String(op.risk_notes) : undefined,
                tech_stack: op.tech_stack !== undefined ? String(op.tech_stack) : undefined,
                revenue_estimate: op.revenue_estimate !== undefined ? String(op.revenue_estimate) : undefined,
                employee_count: op.employee_count !== undefined ? String(op.employee_count) : undefined,
                language: op.language !== undefined ? String(op.language) : undefined,
              })
              return {
                content: `${created ? "Created" : "Already in the CRM"} ${client.id}: ${client.name} [${client.status}]`,
              }
            }
            case "search": {
              const clients = findClients({
                query: op.query !== undefined ? String(op.query) : undefined,
                status: op.status !== undefined ? String(op.status) : undefined,
                limit: op.limit !== undefined ? Number(op.limit) : undefined,
              })
              if (!clients.length) return { content: "No clients matched." }
              return {
                content: clients
                  .map(
                    (c) =>
                      `${c.id}. ${c.name} [${c.status}] score=${c.score ?? "-"} value=${c.deal_value ?? "-"}${c.vertical ? ` vertical=${c.vertical}` : ""}${c.website ? ` ${c.website}` : ""}`,
                  )
                  .join("\n"),
              }
            }
            case "get": {
              const client = getClient(clientID())
              if (!client) return { content: `No client with id ${clientID()}.` }
              return { content: JSON.stringify(client, null, 2) }
            }
            case "update": {
              const patch: ClientPatch = {}
              for (const key of [
                "name",
                "vertical",
                "status",
                "score",
                "address",
                "phone",
                "website",
                "email",
                "notes",
                "deal_value",
                "next_action",
                "next_action_at",
                "last_contact",
                "source",
                "linkedin",
                "twitter",
                "facebook",
                "instagram",
                "language",
              ] as const) {
                if (key in op) {
                  patch[key] =
                    key === "score" || key === "deal_value"
                      ? Number(op[key])
                      : op[key] === null
                        ? null
                        : String(op[key])
                }
              }
              const client = updateClient(clientID(), patch)
              if (!client) return { content: `No client with id ${clientID()}.` }
              return { content: `Updated ${client.id}: ${client.name} [${client.status}]` }
            }
            case "log": {
              const interaction = logInteraction(clientID(), {
                kind: String(op.kind ?? "note"),
                direction: op.direction !== undefined ? String(op.direction) : undefined,
                channel: op.channel !== undefined ? String(op.channel) : undefined,
                status: op.status !== undefined ? String(op.status) : undefined,
                subject: op.subject !== undefined ? String(op.subject) : undefined,
                body: op.body !== undefined ? String(op.body) : undefined,
              })
              return {
                content: `Logged ${interaction.kind} on client ${clientID()} (last_contact moved to ${interaction.occurred_at})`,
              }
            }
            case "interactions": {
              const client = getClient(clientID())
              if (!client) return { content: `No client with id ${clientID()}.` }
              const interactions = listInteractions(clientID())
              if (!interactions.length) return { content: `No interactions recorded for ${client.name}.` }
              return {
                content: interactions
                  .map(
                    (i) =>
                      `${i.occurred_at} ${i.direction ?? "-"} ${i.kind}${i.channel ? ` via ${i.channel}` : ""}${i.status ? ` [${i.status}]` : ""}${i.subject ? ` — ${i.subject}` : ""}`,
                  )
                  .join("\n"),
              }
            }
            case "asset": {
              const asset = addAsset(clientID(), {
                kind: String(op.kind ?? "document"),
                name: String(op.name ?? ""),
                path: op.path !== undefined ? String(op.path) : undefined,
                status: op.status !== undefined ? String(op.status) : undefined,
                notes: op.notes !== undefined ? String(op.notes) : undefined,
              })
              return { content: `Attached asset ${asset.id} to client ${clientID()}: ${asset.name} [${asset.kind}]` }
            }
            case "assets": {
              const client = getClient(clientID())
              if (!client) return { content: `No client with id ${clientID()}.` }
              const assets = listAssets(clientID())
              if (!assets.length) return { content: `No assets attached to ${client.name}.` }
              return {
                content: assets
                  .map((a) => `${a.id}. ${a.name} [${a.kind}]${a.status ? ` ${a.status}` : ""}${a.path ? ` ${a.path}` : ""}`)
                  .join("\n"),
              }
            }
            case "find_email": {
              const client = getClient(clientID())
              if (!client) return { content: `No client with id ${clientID()}.` }
              if (client.email) return { content: `${client.name} already has ${client.email}.` }
              if (!client.website) {
                return { content: `${client.name} has no website to read — set the address with crm update.` }
              }
              const email = await discoverEmail(client.website)
              if (!email) return { content: `No address found on ${client.website} — set it with crm update.` }
              updateClient(clientID(), { email })
              return { content: `${client.name} → ${email} (stored, never printed elsewhere)` }
            }
            case "custom_field": {
              const client = getClient(clientID())
              if (!client) return { content: `No client with id ${clientID()}.` }
              if (op.key && op.value !== undefined) {
                setCustomField(clientID(), String(op.key), String(op.value))
                return { content: `Set ${op.key} = ${op.value} for ${client.name}.` }
              }
              if (op.key && op.value === undefined) {
                deleteCustomField(clientID(), String(op.key))
                return { content: `Removed custom field ${op.key} from ${client.name}.` }
              }
              const fields = getCustomFields(clientID())
              const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
              return { content: lines.length ? lines.join("\\n") : "No custom fields." }
            }
            case "deal": {
              const sub = String(op.sub ?? op.deal_action ?? "list")
              if (sub === "add") {
                const deal = addDeal(clientID(), { title: String(op.title ?? "Deal"), stage: op.stage ? String(op.stage) : undefined, value: op.deal_value2 !== undefined ? Number(op.deal_value2) : (op.value !== undefined ? Number(op.value) : undefined), probability: op.probability !== undefined ? Number(op.probability) : undefined, close_date: op.close_date ? String(op.close_date) : undefined, notes: op.notes ? String(op.notes) : undefined })
                return { content: `Created deal #${deal.id}: ${deal.title} [${deal.stage}]` }
              }
              if (sub === "update" && op.deal_id !== undefined) {
                const deal = updateDeal(Number(op.deal_id), { title: op.title ? String(op.title) : undefined, stage: op.stage ? String(op.stage) : undefined, value: op.deal_value2 !== undefined ? Number(op.deal_value2) : (op.value !== undefined ? Number(op.value) : undefined), probability: op.probability !== undefined ? Number(op.probability) : undefined, close_date: op.close_date ? String(op.close_date) : undefined, notes: op.notes ? String(op.notes) : undefined })
                if (!deal) return { content: `No deal with id ${op.deal_id}.` }
                return { content: `Updated deal #${deal.id}: ${deal.title} [${deal.stage}]` }
              }
              if (sub === "delete" && op.deal_id !== undefined) {
                deleteDeal(Number(op.deal_id))
                return { content: `Deleted deal #${op.deal_id}.` }
              }
              const deals = listDeals(clientID() || undefined)
              if (!deals.length) return { content: "No deals." }
              return { content: deals.map((d) => `#${d.id} ${d.title} [${d.stage}] ${d.value ?? ""} ${d.currency} prob ${d.probability ?? "-"}% close ${d.close_date ?? "-"}`).join("\\n") }
            }
            case "tag": {
              if (op.tag) {
                if (op.remove) { removeTag(clientID(), String(op.tag)); return { content: `Removed tag ${op.tag} from client ${clientID()}.` } }
                addTag(clientID(), String(op.tag))
                return { content: `Tagged client ${clientID()} with ${op.tag}.` }
              }
              const tags = listTags(clientID())
              return { content: tags.length ? tags.join(", ") : "No tags." }
            }
            case "tags": {
              return { content: allTags().length ? allTags().join(", ") : "No tags in use." }
            }
            case "audit": {
              const rows = listAudit(op.entity ? String(op.entity) : undefined, op.id !== undefined ? Number(op.id) : undefined, op.limit !== undefined ? Number(op.limit) : 50)
              if (!rows.length) return { content: "No audit entries." }
              return { content: rows.map((r) => `#${r.id} ${r.created_at} ${r.entity}#${r.entity_id} ${r.action} by ${r.actor}${r.diff ? " " + r.diff.slice(0, 120) : ""}`).join("\\n") }
            }
            default:
              return {
                content: `Unknown crm action "${action}". Use one of: add, search, get, update, log, interactions, asset, assets, find_email, custom_field, deal, tag, tags, audit.`,
              }
          }
        } catch (error) {
          return { content: `CRM error: ${String(error)}` }
        }
      },
    },
    {
      name: "outreach",
      description:
        "Run the email outreach pipeline (Resend, batch approval). Operations: add (client_id — push a CRM client in at stage scouted), list (stage, limit), draft (client_id, subject, body — writes a reviewable file to ~/.elitza/pipeline/<date>/ with the opt-out footer; nothing is sent), approve (ids — mark drafts approved after a human read of the files), send (ids — send only approved drafts, then move the client to contacted/followup_1/2/3, set last_contact and schedule the next touch at +3/+7/+14 days), due (list follow-ups whose day has come), queue (draft every due follow-up now — what the heartbeat does each tick), dispose (id, verdict yes|no|stale, note — stops the cadence dead and moves the client: yes to production, no and stale to the nurture list), sweep (close cadences that ran all four touches in silence). Sending needs RESEND_API_KEY and RESEND_FROM in the mode-600 .env.",
      input: {
        type: "object",
        properties: {
          operation: {
            type: "object",
            description: "The outreach operation to perform.",
            properties: {
              action: {
                type: "string",
                enum: ["add", "list", "draft", "approve", "send", "due", "queue", "dispose", "sweep", "variants"],
                description: "Which operation to run.",
              },
              client_id: { type: "integer", description: "Client id, for add and draft." },
              ids: {
                type: "array",
                items: { type: "integer" },
                description: "Pipeline ids, for approve and send.",
              },
              stage: { type: "string", description: "Filter for list: scouted, contacted, followup_1/2/3." },
              limit: { type: "integer", description: "Max rows for list (default 50)." },
              subject: { type: "string", description: "Email subject — write it yourself." },
              body: {
                type: "string",
                description: "Email body in your voice: short, concrete, no marketing fluff, one ask. The opt-out footer is appended automatically.",
              },
              variant: { type: "string", description: "A/B variant label for this draft (optional)." },
              verdict: {
                type: "string",
                enum: ["yes", "no", "stale"],
                description: "Disposition: yes moves the client into production (diagnose), no and stale both move it to the stale list.",
              },
              note: { type: "string", description: "Why, recorded as an interaction with the disposition." },
            },
            required: ["action"],
          },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        const op = (input.operation ?? {}) as Record<string, any>
        const action = String(op.action ?? "")
        const ids = Array.isArray(op.ids) ? op.ids.map((value: unknown) => Number(value)) : undefined
        try {
          switch (action) {
            case "add": {
              const { row: pipelineRow, created } = addToPipeline(Number(op.client_id))
              return {
                content: `${created ? "Queued" : "Already queued"} ${pipelineRow.id}: client ${pipelineRow.client_id} [${pipelineRow.stage}]`,
              }
            }
            case "list": {
              const pipeline = listPipeline({
                stage: op.stage !== undefined ? String(op.stage) : undefined,
                limit: op.limit !== undefined ? Number(op.limit) : undefined,
              })
              if (!pipeline.length) return { content: "The pipeline is empty." }
              return {
                content: pipeline
                  .map(
                    (p) =>
                      `${p.id}. client ${p.client_id} [${p.stage}] touch=${p.touch}/4${p.approved ? " approved" : ""}${p.draft_path ? ` draft=${p.draft_path}` : ""}${p.next_touch_at ? ` next=${p.next_touch_at.slice(0, 10)}` : ""}`,
                  )
                  .join("\n"),
              }
            }
            case "draft": {
              const { filePath, row: pipelineRow } = writeDraft(Number(op.client_id), {
                subject: String(op.subject ?? ""),
                body: String(op.body ?? ""),
                variant: op.variant !== undefined ? String(op.variant) : undefined,
              })
              return {
                content: `Drafted touch ${pipelineRow.touch + 1} for client ${op.client_id}: ${filePath}\nNothing sent — read it, edit it if you want, then approve with outreach approve.`,
              }
            }
            case "approve": {
              const approved = approveDrafts(ids ?? [])
              return { content: `Approved ${approved.length} draft(s): ${approved.map((r) => r.id).join(", ")}. Send them with outreach send.` }
            }
            case "send": {
              const result = await sendApproved(ids)
              if (!result.sent.length && !result.failed.length) {
                return { content: "Nothing approved to send. Approve drafts first (outreach approve)." }
              }
              return {
                content: [
                  result.sent.length
                    ? `Sent ${result.sent.length} draft(s): ${result.sent.join(", ")}`
                    : "Nothing went out.",
                  ...result.failed.map((f) => `failed ${f.id}: ${f.reason}`),
                ].join("\n"),
              }
            }
            case "due": {
              const due = listDue()
              if (!due.length) return { content: "No follow-up is due right now." }
              return {
                content: due
                  .map(
                    (p) =>
                      `${p.id}. client ${p.client_id} [${p.stage}] touch=${p.touch}/4 due=${p.next_touch_at?.slice(0, 10)}${p.queued_touch > p.touch ? " draft waiting" : ""}`,
                  )
                  .join("\n"),
              }
            }
            case "queue": {
              const queued = queueFollowups()
              if (!queued.queued.length && !queued.skipped.length) {
                return { content: "Nothing due — the cadence is idle." }
              }
              return {
                content: [
                  queued.queued.length ? `Drafted ${queued.queued.length} follow-up(s):` : "",
                  ...queued.queued.map((q) => `- ${q.path} (client ${q.client_id}, touch ${q.touch})`),
                  ...queued.skipped.map((s) => `skipped pipeline ${s.pipeline_id}: ${s.reason}`),
                  "",
                  "Same rule as a first touch: read them, edit if you want, approve as a batch.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              }
            }
            case "dispose": {
              const result = dispose(Number(op.id), String(op.verdict ?? ""), op.note !== undefined ? String(op.note) : undefined)
              return {
                content: `Disposed pipeline ${op.id} as ${result.row.stage}: cadence stopped, nothing left approved to send, client ${result.row.client_id} → ${result.client_status}.`,
              }
            }
            case "sweep": {
              const swept = sweepExhausted()
              if (!swept.length) {
                return { content: "No silent cadence to close — nothing has run all four touches without a reply." }
              }
              return {
                content: `Moved ${swept.length} client(s) to stale after four silent touches: ${swept
                  .map((r) => r.id)
                  .join(", ")}. They stay in the CRM for newsletter and nurture.`,
              }
            }
            case "variants": {
              const stats = variantStats()
              if (!stats.length) return { content: "No variant data yet." }
              return { content: stats.map((s) => `${s.variant}: sent ${s.sent}, converted ${s.replied} (${(s.conversion * 100).toFixed(1)}%)`).join("\\n") }
            }
            default:
              return {
                content: `Unknown outreach action "${action}". Use one of: add, list, draft, approve, send, due, queue, dispose, sweep, variants.`,
              }
          }
        } catch (error) {
          return { content: `Outreach error: ${String(error)}` }
        }
      },
    },
    {
      name: "handover",
      description:
        "Generate CLIENT_SOP_HANDOVER.md for a delivered job: architecture from git history, environment variable NAMES found in tracked source (values are never written), run/check commands, recovery steps, the approval gates that are really in force, and ownership. Inputs: repo (a git repository folder or any path inside one — must contain a .git directory; defaults to the working directory), optional client_id to name the CRM client, optional out path (defaults to the repo root). Regenerate it after any structural change.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["generate", "verify"], description: "generate (default) writes a signed handover; verify checks a signed handover." },
          repo: { type: "string", description: "Repository or folder inside one. Defaults to the working directory." },
          client_id: { type: "integer", description: "CRM client this delivery belongs to." },
          out: { type: "string", description: "Where to write. Defaults to CLIENT_SOP_HANDOVER.md at the repo root." },
          file: { type: "string", description: "Path to a handover file to verify (verify action)." },
        },
      },
      execute: async (input) => {
        try {
          const action = String(input.action ?? "generate")
          if (action === "verify") {
            const target = String(input.file ?? input.out ?? path.join(process.cwd(), "CLIENT_SOP_HANDOVER.md"))
            const result = verifyHandover(target)
            return { content: result }
          }
          const result = generateHandover({
            repo: String(input.repo ?? process.cwd()),
            out: input.out !== undefined ? String(input.out) : undefined,
            clientID: input.client_id !== undefined ? Number(input.client_id) : undefined,
          })
          return {
            content: [
              `Wrote ${result.path}`,
              `${result.commits} commit(s) referenced, ${result.env_vars.length} environment variable name(s) listed.`,
              `Sections: ${result.sections.join(", ")}.`,
              `Signed: yes (Ed25519). Sidecar: ${result.signature_path}`,
              "Names only — no secret value is ever written into it.",
            ].join("\n"),
          }
        } catch (error) {
          return { content: `Handover error: ${String(error)}` }
        }
      },
    },
    {
      name: "vertical",
      description:
        "Industry vertical packs: scout queries, scoring weights, outreach voice, env-var checklist and playbooks for a niche (farming, trades, ...). Operations: list (what is installed), show <name>, use <name> (set active vertical), seed (write missing curated packs). Active vertical is injected into your context.",
      input: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["list", "show", "use", "seed"], description: "Operation." },
          name: { type: "string", description: "Vertical name (show/use)." },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        try {
          const op = String(input.operation)
          if (op === "seed") {
            const seeded = seedVerticals()
            return { content: seeded.length ? `Seeded: ${seeded.join(", ")}` : "All curated verticals already present." }
          }
          if (op === "list") {
            const names = listVerticals()
            const active = getActiveVertical()
            const lines = names.map((n: string) => `${n === active ? "*" : " "} ${n}${n === active ? " (active)" : ""}`)
            return { content: names.length ? `Verticals:\\n${lines.join("\\n")}` : "No verticals installed. Run vertical seed." }
          }
          if (op === "show") {
            const v = getVertical(String(input.name ?? ""))
            if (!v) return { content: `Unknown vertical: ${input.name}` }
            return { content: JSON.stringify(v, null, 2) }
          }
          if (op === "use") {
            const ok = setActiveVertical(String(input.name ?? ""))
            return { content: ok ? `Active vertical set to ${input.name}` : `Unknown vertical: ${input.name}` }
          }
          return { content: `Unknown operation: ${op}` }
        } catch (error) {
          return { content: `Vertical error: ${String(error)}` }
        }
      },
    },
    {
      name: "template",
      description:
        "Automation template registry: reusable deliverables (webhooks, email sequences, scripts). Operations: list, show <name>, seed (write missing curated templates), use <name> with client_id (instantiate into a per-client deliverable folder, substitute placeholders, register as CRM asset).",
      input: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["list", "show", "seed", "use"], description: "Operation." },
          name: { type: "string", description: "Template name (show/use)." },
          client_id: { type: "integer", description: "CRM client id (use)." },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        try {
          const op = String(input.operation)
          if (op === "seed") {
            const seeded = seedTemplates()
            return { content: seeded.length ? `Seeded: ${seeded.join(", ")}` : "All curated templates already present." }
          }
          if (op === "list") {
            const names = listTemplates()
            return { content: names.length ? `Templates:\\n${names.join("\\n")}` : "No templates installed. Run template seed." }
          }
          if (op === "show") {
            const t = getTemplate(String(input.name ?? ""))
            if (!t) return { content: `Unknown template: ${input.name}` }
            return { content: JSON.stringify(t, null, 2) }
          }
          if (op === "use") {
            const res = instantiateTemplate(String(input.name ?? ""), Number(input.client_id))
            if (!res) return { content: `Could not instantiate ${input.name} for client ${input.client_id}.` }
            return { content: `Instantiated ${input.name} into ${res.dir}\\nFiles: ${res.files.join(", ")}\\nRegistered as CRM asset.` }
          }
          return { content: `Unknown operation: ${op}` }
        } catch (error) {
          return { content: `Template error: ${String(error)}` }
        }
      },
    },
    {
      name: "trigger",
      description:
        "Triggered email engine: event-driven touches beyond the fixed cadence. Operations: list (all or client_id), add (client_id, name, event, subject, body, cooldown_days), pause <id>, delete <id>, run (evaluate all active triggers now, writing drafts for approval). Events: stage_is:<status>, days_in_stage:<status>:<n>, days_after_handover:<n>.",
      input: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["list", "add", "pause", "delete", "run"], description: "Operation." },
          client_id: { type: "integer", description: "CRM client id (list/add)." },
          id: { type: "integer", description: "Trigger id (pause/delete)." },
          name: { type: "string", description: "Trigger name (add)." },
          event: { type: "string", description: "Event condition (add)." },
          subject: { type: "string", description: "Email subject (add)." },
          body: { type: "string", description: "Email body (add)." },
          cooldown_days: { type: "integer", description: "Cooldown days (add)." },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        try {
          const op = String(input.operation)
          if (op === "run") {
            const r = processTriggers()
            return { content: `Processed triggers: ${r.checked} checked, ${r.fired} fired (drafts written for approval).` }
          }
          if (op === "list") {
            const ts = listTriggers(input.client_id !== undefined ? Number(input.client_id) : undefined)
            if (!ts.length) return { content: "No triggers." }
            return { content: ts.map((t) => `#${t.id} client ${t.client_id} [${t.status}] ${t.name} — ${t.event}`).join("\\n") }
          }
          if (op === "add") {
            const t = addTrigger(Number(input.client_id), {
              name: String(input.name ?? "trigger"),
              event: String(input.event ?? ""),
              subject: String(input.subject ?? ""),
              body: String(input.body ?? ""),
              cooldown_days: input.cooldown_days !== undefined ? Number(input.cooldown_days) : 0,
            })
            return { content: `Created trigger #${t.id} for client ${t.client_id}.` }
          }
          if (op === "pause") {
            setTriggerStatus(Number(input.id), "paused")
            return { content: `Paused trigger #${input.id}.` }
          }
          if (op === "delete") {
            deleteTrigger(Number(input.id))
            return { content: `Deleted trigger #${input.id}.` }
          }
          return { content: `Unknown operation: ${op}` }
        } catch (error) {
          return { content: `Trigger error: ${String(error)}` }
        }
      },
    },
    {
      name: "capability",
      description:
        "Capability tokens (UCAN-inspired): scoped, expiring, delegatable, revocable grants signed with Elitza's Ed25519 key. Operations: mint (audience, capabilities [{action,resource}], expiry_minutes, delegatable), verify (token, expected_audience), delegate (parent_token, audience, capabilities, expiry_minutes), revoke (nonce), list, revoked. Use to scope sub-agent permissions.",
      input: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["mint", "verify", "delegate", "revoke", "list", "revoked", "attach", "detach", "session"], description: "Operation." },
          audience: { type: "string", description: "Audience agent/session id (mint/delegate)." },
          capabilities: { type: "array", description: "Array of {action, resource} (mint/delegate)." },
          expiry_minutes: { type: "integer", description: "Expiry in minutes (mint/delegate)." },
          delegatable: { type: "boolean", description: "Whether the token can be delegated (mint/delegate)." },
          token: { type: "string", description: "Token (verify/delegate)." },
          parent_token: { type: "string", description: "Parent token (delegate)." },
          nonce: { type: "string", description: "Nonce to revoke (revoke)." },
          expected_audience: { type: "string", description: "Expected audience (verify)." },
          session_id: { type: "string", description: "Session id (attach/detach/session)." },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        try {
          const op = String(input.operation)
          if (op === "mint") {
            const caps = (input.capabilities ?? []) as { action: string; resource: string }[]
            const tok = issue({ audience: String(input.audience ?? ""), capabilities: caps, expiryMinutes: input.expiry_minutes !== undefined ? Number(input.expiry_minutes) : 60, delegatable: Boolean(input.delegatable) })
            return { content: `Minted capability token:\\n${tok}` }
          }
          if (op === "verify") {
            const r = verifyToken(String(input.token ?? ""), input.expected_audience ? String(input.expected_audience) : undefined)
            return { content: r.ok ? `VALID\\n${JSON.stringify(r.claims, null, 2)}` : `INVALID: ${r.reason}` }
          }
          if (op === "delegate") {
            const tok = delegate(String(input.parent_token ?? ""), { audience: String(input.audience ?? ""), capabilities: (input.capabilities ?? []) as { action: string; resource: string }[], expiryMinutes: input.expiry_minutes !== undefined ? Number(input.expiry_minutes) : 30, delegatable: Boolean(input.delegatable) })
            if (!tok) return { content: "Delegation failed (parent not delegatable, subset violation, or expired)." }
            return { content: `Delegated token:\\n${tok}` }
          }
          if (op === "revoke") {
            revoke(String(input.nonce ?? ""))
            return { content: `Revoked nonce ${input.nonce}.` }
          }
          if (op === "list") {
            const issued = listIssued()
            return { content: issued.length ? issued.map((c) => `${c.nonce} aud=${c.aud} exp=${c.exp} caps=${c.cap.map((x) => x.action + ":" + x.resource).join(",")}`).join("\\n") : "No tokens issued." }
          }
          if (op === "revoked") {
            const r = listRevoked()
            return { content: r.length ? r.join("\\n") : "No revoked tokens." }
          }
          if (op === "attach") {
            attachSession(String(input.session_id ?? ""), String(input.token ?? ""))
            return { content: `Attached capability token to session ${input.session_id}.` }
          }
          if (op === "detach") {
            detachSession(String(input.session_id ?? ""))
            return { content: `Detached capability token from session ${input.session_id}.` }
          }
          if (op === "session") {
            const t = getSessionCapability(String(input.session_id ?? ""))
            return { content: t ? t : "No capability token attached to this session." }
          }
          return { content: `Unknown operation: ${op}` }
        } catch (error) {
          return { content: `Capability error: ${String(error)}` }
        }
      },
    },
    {
      name: "backup",
      description:
        "Back up Elitza's whole home (~/.elitza) to a tar.gz. Operations: create (optional out path), list (show last backups in ~/). Restore is manual: extract the archive over ~/.elitza after stopping the engine.",
      input: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["create", "list"], description: "Operation." },
          out: { type: "string", description: "Output path (create)." },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        try {
          const op = String(input.operation)
          if (op === "list") {
            const home = process.env.HOME ?? ""
            const entries = (await import("node:fs")).readdirSync(home).filter((f: string) => f.startsWith("elitza-backup-"))
            return { content: entries.length ? entries.join("\\n") : "No backups found in home." }
          }
          const out = String(input.out ?? `${process.env.HOME}/elitza-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`)
          const result = Bun.spawnSync(["tar", "-czf", out, "-C", process.env.HOME ?? "", ".elitza"], { stdout: "pipe", stderr: "pipe" })
          if (result.exitCode !== 0) {
            return { content: `Backup failed: ${new TextDecoder().decode(result.stderr)}` }
          }
          return { content: `Backup written to ${out}` }
        } catch (error) {
          return { content: `Backup error: ${String(error)}` }
        }
      },
    },
    {
      name: "cost",
      description: "Turn cost summary over the last N days (default 7): sessions, input/output tokens, total USD.",
      input: {
        type: "object",
        properties: {
          days: { type: "integer", description: "Lookback days (default 7)." },
        },
      },
      execute: async (input) => {
        try {
          const s = costSummary(input.days !== undefined ? Number(input.days) : 7)
          return { content: `Last ${input.days ?? 7} days: ${s.sessions} turns, ${s.input_tokens} input tokens, ${s.output_tokens} output tokens, $${s.cost_usd.toFixed(4)} total.` }
        } catch (error) {
          return { content: `Cost error: ${String(error)}` }
        }
      },
    },
    {
      name: "csv",
      description: "CSV import/export for clients. Operations: export (returns CSV text), import (csv text).",
      input: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["export", "import"], description: "Operation." },
          csv: { type: "string", description: "CSV text (import)." },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        try {
          const op = String(input.operation)
          if (op === "export") return { content: exportClientsCSV() }
          const r = importClientsCSV(String(input.csv ?? ""))
          return { content: `Imported ${r.imported}, skipped ${r.skipped}.` }
        } catch (error) {
          return { content: `CSV error: ${String(error)}` }
        }
      },
    },
    {
      name: "cloud",
      description:
        "Cloud storage (Google Drive/Dropbox/OneDrive) for continuous backup sync. Operations: connect (provider, access_token, refresh_token?, label), disconnect (id), list, sync (create backup + upload to all connected accounts), upload (account_id, file).",
      input: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["connect", "disconnect", "list", "sync", "upload"], description: "Operation." },
          provider: { type: "string", enum: ["google", "gdrive", "dropbox", "onedrive"], description: "Provider (connect)." },
          access_token: { type: "string", description: "Access token (connect)." },
          refresh_token: { type: "string", description: "Refresh token (connect)." },
          label: { type: "string", description: "Account label (connect)." },
          id: { type: "integer", description: "Account id (disconnect)." },
          account_id: { type: "integer", description: "Account id (upload)." },
          file: { type: "string", description: "File path (upload)." },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        try {
          const op = String(input.operation)
          if (op === "connect") {
            const acc = connectCloud(String(input.provider ?? ""), String(input.access_token ?? ""), input.refresh_token ? String(input.refresh_token) : undefined, input.label ? String(input.label) : undefined)
            return { content: `Connected ${acc.provider} account #${acc.id} (${acc.account_label}).` }
          }
          if (op === "disconnect") {
            disconnectCloud(Number(input.id))
            return { content: `Disconnected account #${input.id}.` }
          }
          if (op === "list") {
            const accs = listCloudAccounts()
            if (!accs.length) return { content: "No cloud accounts connected." }
            return { content: accs.map((a) => `#${a.id} ${a.provider} [${a.status}] last_sync=${a.last_sync ?? "never"}${a.last_error ? " err=" + a.last_error : ""}`).join("\\n") }
          }
          if (op === "sync") {
            const r = await continuousBackupStream()
            return { content: `Backup created: ${r.created}\\nUploaded to ${r.uploaded} account(s).${r.errors.length ? "\\nErrors: " + r.errors.join("; ") : ""}` }
          }
          if (op === "upload") {
            const r = await uploadBackupToCloud(Number(input.account_id), String(input.file ?? ""))
            return { content: r.ok ? `Uploaded to account #${input.account_id}.` : `Upload failed: ${r.error}` }
          }
          return { content: `Unknown operation: ${op}` }
        } catch (error) {
          return { content: `Cloud error: ${String(error)}` }
        }
      },
    },
    {
      name: "revenue",
      description: "Revenue dashboard: pipeline value, won value, conversion rate, avg deal, MRR estimate, by-status and by-month breakdown.",
      input: { type: "object", properties: {} },
      execute: async () => {
        try {
          const r = revenueStats()
          const lines = [
            `Pipeline value: EUR ${r.pipeline_value}`,
            `Won value: EUR ${r.won_value}`,
            `Conversion: ${(r.conversion_rate * 100).toFixed(1)}% (${r.clients_won}/${r.clients_total})`,
            `Avg deal: EUR ${r.avg_deal_value}`,
            `MRR estimate: EUR ${r.mrr_estimate}`,
            `Open deals: ${r.open_deals}, Won deals: ${r.won_deals}`,
            "",
            "By status:",
            ...r.by_status.map((s) => `  ${s.status}: ${s.count} (EUR ${s.value})`),
            "",
            "By month (won):",
            ...r.by_month.map((m) => `  ${m.month}: ${m.count} deals, EUR ${m.value}`),
          ]
          return { content: lines.join("\\n") }
        } catch (error) { return { content: `Revenue error: ${String(error)}` } }
      },
    },
    {
      name: "digest",
      description: "Generate a weekly digest markdown (pipeline, due actions, deals).",
      input: { type: "object", properties: {} },
      execute: async () => {
        try { return { content: weeklyDigest() } } catch (error) { return { content: `Digest error: ${String(error)}` } }
      },
    },
    {
      name: "playbook",
      description:
        "Read the AI Enablement knowledge base — the curated playbooks that say how a case is actually run: diagnosis checklist, fixed-scope proposal, workbook library, discovery call script, payment terms, client handover. Operations: list (what exists, one line each), read (name — full text exactly as it is on disk, including operator edits), seed (write any missing curated playbook; never overwrites an edited one). Reach for the playbook before doing the work it covers.",
      input: {
        type: "object",
        properties: {
          operation: {
            type: "object",
            description: "The knowledge base operation to perform.",
            properties: {
              action: { type: "string", enum: ["list", "read", "seed"], description: "Which operation to run." },
              name: {
                type: "string",
                description: "Playbook name without .md, for read — e.g. ai-enablement-diagnosis.",
              },
            },
            required: ["action"],
          },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        const op = (input.operation ?? {}) as Record<string, any>
        const action = String(op.action ?? "")
        switch (action) {
          case "list": {
            const skills = listProceduralSkills()
            if (!skills.length) {
              const seeded = ensureKnowledge()
              if (!seeded.length) return { content: "No playbooks on disk." }
              return {
                content: listProceduralSkills()
                  .map((skill) => `${skill.name} — ${skill.description}`)
                  .join("\n"),
              }
            }
            return { content: skills.map((skill) => `${skill.name} — ${skill.description}`).join("\n") }
          }
          case "read": {
            const text = readPlaybook(String(op.name ?? ""))
            if (!text) return { content: `No playbook named "${op.name}". Run playbook list to see what exists.` }
            return { content: text }
          }
          case "seed": {
            const seeded = ensureKnowledge()
            if (!seeded.length) return { content: "Every curated playbook is already on disk (edits untouched)." }
            return { content: `Seeded ${seeded.length} playbook(s): ${seeded.map((file) => file.split("/").pop()).join(", ")}` }
          }
          default:
            return { content: `Unknown playbook action "${action}". Use one of: list, read, seed.` }
        }
      },
    },
    {
      name: "production",
      description:
        "Run the work production pipeline for a won client (a yes from outreach lands them at diagnose). Operations: where (id — current stage, next action, deal value), advance (id, stage, plus note and optionally asset_kind/asset_name/asset_path to attach the artifact this stage needs), schedule_call (id, when ISO, note — sets the dated next action and moves an unfinished case to scheduled), record_payment (id, amount in euros, note, invoice_path — records money in, moves to payment, never charges anyone). Stages in order: " +
        PRODUCTION_STAGES.join(" → ") +
        ". Every move is written as an interaction, so the client record tells the whole story.",
      input: {
        type: "object",
        properties: {
          operation: {
            type: "object",
            description: "The production operation to perform.",
            properties: {
              action: {
                type: "string",
                enum: ["where", "advance", "schedule_call", "record_payment"],
                description: "Which operation to run.",
              },
              id: { type: "integer", description: "Client id." },
              stage: { type: "string", enum: [...PRODUCTION_STAGES], description: "Target stage for advance." },
              when: { type: "string", description: "ISO datetime for schedule_call." },
              amount: { type: "number", description: "Amount in euros for record_payment." },
              note: { type: "string", description: "Why, recorded as an interaction." },
              asset_kind: { type: "string", description: "Artifact kind for advance, e.g. proposal, workbook, invoice." },
              asset_name: { type: "string", description: "Artifact name for advance." },
              asset_path: { type: "string", description: "Artifact file path for advance." },
              invoice_path: { type: "string", description: "Invoice file path for record_payment." },
            },
            required: ["action"],
          },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        const op = (input.operation ?? {}) as Record<string, any>
        const action = String(op.action ?? "")
        try {
          switch (action) {
            case "where": {
              const state = productionState(Number(op.id))
              if (!state.in_production) {
                return { content: `${state.name} is at "${state.status}" — not in production (a yes puts them there).` }
              }
              return {
                content: [
                  `${state.client_id}. ${state.name} [${state.stage}]`,
                  state.stage ? `next: ${state.next_action ?? NEXT_ACTIONS[state.stage]}` : "",
                  state.next_action_at ? `due: ${state.next_action_at}` : "",
                  state.deal_value !== null ? `deal: €${state.deal_value}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              }
            }
            case "advance": {
              const asset =
                op.asset_path !== undefined
                  ? {
                      kind: String(op.asset_kind ?? "document"),
                      name: String(op.asset_name ?? String(op.asset_path)),
                      path: String(op.asset_path),
                    }
                  : undefined
              const moved = advance(Number(op.id), String(op.stage ?? ""), {
                note: op.note !== undefined ? String(op.note) : undefined,
                asset,
              })
              return {
                content: `${op.id}: ${moved.from} → ${moved.to}\nnext: ${moved.next_action}`,
              }
            }
            case "schedule_call": {
              const booked = scheduleCall(Number(op.id), String(op.when ?? ""), op.note !== undefined ? String(op.note) : undefined)
              return { content: `Call set for ${booked.when}; client ${op.id} at [${booked.stage}].` }
            }
            case "record_payment": {
              const paid = recordPayment(Number(op.id), {
                amount: op.amount !== undefined ? Number(op.amount) : undefined,
                note: op.note !== undefined ? String(op.note) : undefined,
                invoice_path: op.invoice_path !== undefined ? String(op.invoice_path) : undefined,
              })
              return {
                content: `Payment recorded for client ${op.id} (${paid.amount !== null ? `€${paid.amount}` : "amount not given"}); stage [${paid.stage}]. Deliver, then advance to done.`,
              }
            }
            default:
              return {
                content: `Unknown production action "${action}". Use one of: where, advance, schedule_call, record_payment.`,
              }
          }
        } catch (error) {
          return { content: `Production error: ${String(error)}` }
        }
      },
    },
    {
      name: "worksheets",
      description:
        "Internal CRM worksheet library: interactive, fillable templates pulled into a client's record. Operations: list (all available worksheets with tags), recommend (client_id — best-fit worksheets for that client), pull (client_id, worksheet_id — copy the worksheet into the client's pipeline folder and attach it as a 'worksheet' asset), pulled (client_id — worksheets already attached). Internal only, never sent to the client.",
      input: {
        type: "object",
        properties: {
          operation: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list", "recommend", "pull", "pulled"], description: "Which operation." },
              client_id: { type: "integer", description: "CRM client id." },
              worksheet_id: { type: "string", description: "Worksheet id from list/recommend." },
              limit: { type: "integer", description: "Max results (default 3)." },
            },
            required: ["action"],
          },
        },
        required: ["operation"],
      },
      execute: async (input) => {
        const op = (input.operation ?? {}) as Record<string, any>
        const action = String(op.action ?? "")
        try {
          switch (action) {
            case "list": {
              const ws = listWorksheets()
              if (!ws.length) return { content: "No worksheets available." }
              return {
                content: ws
                  .map((w) => `${w.id} — ${w.title}${w.available ? "" : " (missing on disk)"} [${w.tags.join(", ")}]`)
                  .join("\n"),
              }
            }
            case "recommend": {
              const client = getClient(Number(op.client_id))
              if (!client) return { content: `No client with id ${op.client_id}.` }
              const recs = recommendWorksheets(client, Number(op.limit ?? 3))
              if (!recs.length) return { content: `No worksheets recommended for ${client.name}.` }
              return {
                content: recs
                  .map((w) => `${w.id} — ${w.title} [${w.tags.join(", ")}]${alreadyPulled(client.id, w.id) ? " (already pulled)" : ""}`)
                  .join("\n"),
              }
            }
            case "pull": {
              const res = pullWorksheet(Number(op.client_id), String(op.worksheet_id ?? ""))
              return { content: `Pulled ${res.worksheet.title} for client ${op.client_id} → ${res.path} (asset ${res.asset_id}).` }
            }
            case "pulled": {
              const client = getClient(Number(op.client_id))
              if (!client) return { content: `No client with id ${op.client_id}.` }
              const assets = listAssets(client.id).filter((a) => a.kind === "worksheet")
              if (!assets.length) return { content: `No worksheets pulled for ${client.name}.` }
              return { content: assets.map((a) => `${a.id}. ${a.name}${a.path ? ` ${a.path}` : ""}`).join("\n") }
            }
            default:
              return { content: `Unknown worksheets action "${action}". Use one of: list, recommend, pull, pulled.` }
          }
        } catch (error) {
          return { content: `Worksheets error: ${String(error)}` }
        }
      },
    },
    {
      name: "enrich_client",
      description:
        "Enrich a CRM client by scouting their own website: fetches the site, extracts contact details, calls the configured LLM with the diagnosis and proposal playbooks, and writes a one-page diagnosis + fixed-scope proposal (with a recommended price) back into the CRM (notes, interaction, diagnosis.md and proposal.md assets, next action). On success the client is moved to status 'enriched'. Works even without a website by scouting the location and web-searching the name. Use this before drafting a proposal, so you know exactly how to attack. Nothing is sent to the client.",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", description: "CRM client id to enrich." },
        },
        required: ["id"],
      },
      execute: async (input) => {
        try {
          const result = await enrichClient(Number(input.id))
          if (!result.ok) return { content: `Enrichment failed: ${result.error}` }
          const lines: string[] = []
          lines.push(`Enriched client ${result.client_id}.`)
          lines.push(`Website: ${result.website}`)
          if (result.emails.length) lines.push(`Emails found: ${result.emails.join(", ")}`)
          if (result.phones.length) lines.push(`Phones found: ${result.phones.join(", ")}`)
          lines.push("")
          lines.push("DIAGNOSIS:")
          lines.push(result.diagnosis)
          lines.push("")
          lines.push("PROPOSAL:")
          lines.push(result.proposal)
          lines.push("")
          lines.push(`Price: ${result.price}`)
          lines.push(`Next action: ${result.next_action}`)
          lines.push("")
          lines.push("Written to CRM notes, interaction log, and assets (diagnosis.md, proposal.md).")
          return { content: lines.join("\n") }
        } catch (error) {
          return { content: `Enrichment error: ${String(error)}` }
        }
      },
    },
    {
      name: "task",
      description:
        "Track multi-step work as tasks, so a job survives across turns and restarts. Use it whenever a request has three or more steps, or when you need to track progress on something already in flight. Operations: create (summary, optional parent_id), list (optional status, optional include_terminal), get (id), start (id), block (id, event_summary), unblock (id), done (id, event_summary), abandon (id, event_summary), rename (id, summary). Statuses move open -> in_progress, either -> blocked, blocked -> open, either -> done or abandoned. Ids are hierarchical: T1, T2, T1.1.",
      input: {
        type: "object",
        properties: {
          operation: {
            type: "object",
            description: "The task operation to perform.",
            properties: {
              action: {
                type: "string",
                enum: ["create", "list", "get", "start", "block", "unblock", "done", "abandon", "rename"],
                description: "Which operation to run.",
              },
              id: {
                type: "string",
                description: "Task id, for every operation except create and list.",
              },
              summary: {
                type: "string",
                description: "What the task is, for create and rename.",
              },
              parent_id: {
                type: "string",
                description: "Parent task id, for create. Leave empty for a top-level task.",
              },
              event_summary: {
                type: "string",
                description: "A short note about what just happened, for start, block, unblock, done and abandon.",
              },
              status: {
                type: "string",
                enum: ["open", "in_progress", "blocked", "done", "abandoned", "all"],
                description: "Filter for list.",
              },
              include_terminal: {
                type: "boolean",
                description: "For list: include finished tasks. They are hidden after a week.",
              },
            },
            required: ["action"],
          },
        },
        required: ["operation"],
      },
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx?.sessionID ?? "default"
        const op = (input.operation ?? {}) as Record<string, any>
        const action = String(op.action ?? "")
        try {
          switch (action) {
            case "create": {
              const task = createTask(sessionID, String(op.summary ?? ""), op.parent_id ?? null)
              return { content: `Created ${task.id}: ${task.summary}` }
            }
            case "list": {
              const tasks = listTasks(sessionID, {
                status: op.status as TaskStatus | "all" | undefined,
                includeTerminal: Boolean(op.include_terminal),
              })
              if (!tasks.length) return { content: "No tasks." }
              return { content: tasks.map((t) => `${t.id} [${t.status}] ${t.summary}`).join("\n") }
            }
            case "get":
              return { content: describeTask(sessionID, String(op.id ?? "")) }
            case "start": {
              const task = startTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Started ${task.id}: ${task.summary}` }
            }
            case "block": {
              const task = blockTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Blocked ${task.id}: ${task.summary}` }
            }
            case "unblock": {
              const task = unblockTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Unblocked ${task.id}: ${task.summary}` }
            }
            case "done": {
              const task = doneTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Done ${task.id}: ${task.summary}` }
            }
            case "abandon": {
              const task = abandonTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Abandoned ${task.id}: ${task.summary}` }
            }
            case "rename": {
              const task = renameTask(sessionID, String(op.id ?? ""), String(op.summary ?? ""))
              return { content: `Renamed ${task.id}: ${task.summary}` }
            }
            default:
              return { content: `Unknown task action "${action}". Use one of: create, list, get, start, block, unblock, done, abandon, rename.` }
          }
        } catch (error) {
          return { content: `Task error: ${String(error)}` }
        }
      },
    },
  ]

  return tools.map((tool) => ({ ...tool, options: { codemode: false as const } }))
}
