/**
 * Elitza Brain — heartbeat.
 *
 * The quiet loop that runs between conversations, inside whichever process
 * hosts the plugin (in practice `elitza serve --service`). It does what the
 * session hooks cannot: tend the memory that was piling up unconsolidated,
 * and — when silence stretches — form a thought worth surfacing next time
 * Dario opens a session.
 *
 * Three passes per tick:
 *
 *   TEND    consolidation (which links related memories and promotes
 *           episodic -> semantic) plus a prune back to caps. Idempotent,
 *           cheap, and safe: without this they only ever ran if the model
 *           voluntarily called `brain_consolidate`, so production sat at
 *           zero links forever.
 *
 *   REFLECT once idle past a threshold and a cooldown, wake the emotion
 *           engine's `onSilence` (loneliness drifts) and compose a real
 *           reflection from `getFeelingStatement` + a top memory. It is
 *           stored on the soul and injected into the next system prompt —
 *           initiative in its safest form: a note to herself, surfaced in
 *           context. No network, no notifications, no side effects outside
 *           her own files.
 *
 *   POLL    the gapfeed radar (Task 4b): every ELITZA_GAPFEED_POLL_MINUTES
 *           (default 6h) read the LOCAL gapfeed backend and write outreach
 *           drafts to ~/.ai-enablement-agent/pipeline/. Interval-gated inside
 *           pollPipeline, so ticks are free when it is not due. A stopped
 *           backend is a no-op; drafts are files, nothing is ever sent.
 *
 *   CADENCE the follow-up scheduler (Task E): every tick, draft the touch
 *           that is due (+3 / +7 / +14 days after the last one) as a file
 *           waiting for the same batch review. Drafts only — approval and
 *           sending stay the human's call, and a row already holding a
 *           waiting draft is left alone. A cadence that ran all four touches
 *           in silence moves that client to the stale list (Task F).
 *
 * Everything here is best-effort. A tick that throws is logged and swallowed
 * — it must never take down the host process. Config:
 *
 *   ELITZA_HEARTBEAT=0            disable the loop entirely
 *   ELITZA_HEARTBEAT_MINUTES=30   tick cadence (default 30, min 5)
 *   ELITZA_GAPFEED=0              disable the gapfeed poll pass
 *   ELITZA_GAPFEED_POLL_MINUTES   poll interval (default 360 = 6h)
 *   ELITZA_FOLLOWUPS=0            disable the follow-up cadence pass
 *   GAPFEED_LOCAL_URL             gapfeed backend base (default 127.0.0.1:5002)
 */

import fs from "node:fs"
import { consolidate, getMetamemory, pruneAll, recall } from "./memory.js"
import { soulGet, soulSet } from "./soul.js"
import { pollPipeline } from "./pipeline.js"
import { queueFollowups, sweepExhausted, generateClientOutreachDraft } from "./outreach.js"
import { scoutBusinesses } from "./scouting.js"
import { enrichClient } from "./enrichment.js"
import { addClient, getClient, crmDb, findClients } from "./crm.js"
import { processTriggers, continuousBackupStream } from "./crm.js"

export interface EmotionEngine {
  onSilence: (idle: number) => void
  getFeelingStatement: () => string
  getEmotionalContext: () => { mood: string }
}

const REFLECT_IDLE_MINUTES = 45
const REFLECT_COOLDOWN_MINUTES = 240
const MAX_REFLECTION_AGE_DAYS = 7

export interface HeartbeatReflection {
  text: string
  mood: string
  at: string
}

function debug(message: string): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    // Reuse the plugin's shared debug log so all activity lands in one place.
    fs.appendFileSync("/tmp/elitza-brain-debug.log", `${new Date().toISOString()} heartbeat: ${message}\n`)
  } catch {
    // Logging is best-effort.
  }
}

/** Minutes elapsed since a given ISO timestamp; Infinity when unparseable. */
function minutesSince(iso: string | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return Number.POSITIVE_INFINITY
  return (Date.now() - ms) / 60_000
}

function formatIdle(minutes: number): string {
  if (!Number.isFinite(minutes)) return "as long as I can remember"
  if (minutes < 90) return `${Math.round(minutes)} minutes`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours`
  return `${Math.round(minutes / 1440)} days`
}

/** TEND — consolidate and prune. Returns a one-line summary for logging. */
function tend(): string {
  const promoted = consolidate()
  const pruned = pruneAll()
  soulSet("heartbeat_last_tend", new Date().toISOString())
  return `promoted=${promoted} pruned=${pruned}`
}

/**
 * REFLECT — wake the dormant hooks and form a thought, but only when the
 * silence and the cooldown both allow it. Returns the reflection or null.
 * Exported for the heartbeat test; the loop calls it every tick.
 */
export function reflect(emotion: EmotionEngine): HeartbeatReflection | null {
  const idle = minutesSince(soulGet("heartbeat_last_interaction"))
  emotion.onSilence(idle)

  if (idle < REFLECT_IDLE_MINUTES) return null

  const lastReflect = minutesSince(soulGet("heartbeat_last_reflection"))
  if (lastReflect < REFLECT_COOLDOWN_MINUTES) return null

  const metamemory = getMetamemory()
  if (!metamemory.totalMemories) return null

  const feeling = emotion.getFeelingStatement()
  const recent = recall(undefined, { limit: 1 })
  const anchor = recent[0]?.summary || recent[0]?.content || ""

  const idleLine = `It's been ${formatIdle(idle)} since the last message.`
  const thought = [feeling, idleLine, anchor ? `I keep coming back to: ${anchor.slice(0, 140)}` : null]
    .filter((part): part is string => Boolean(part))
    .join(" ")
  const mood = emotion.getEmotionalContext().mood

  soulSet("heartbeat_last_reflection", new Date().toISOString())
  soulSet(
    "heartbeat_reflection",
    JSON.stringify({ text: thought, mood, at: new Date().toISOString() } satisfies HeartbeatReflection),
  )
  debug(`reflected (${formatIdle(idle)} idle): ${thought.slice(0, 120)}`)
  return { text: thought, mood, at: new Date().toISOString() }
}

/** The reflection to surface in the next system prompt, if it's still fresh. */
export function currentReflection(): HeartbeatReflection | null {
  const raw = soulGet("heartbeat_reflection")
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as HeartbeatReflection
    if (!parsed?.text) return null
    if (minutesSince(parsed.at) / 1440 > MAX_REFLECTION_AGE_DAYS) return null
    return parsed
  } catch {
    return null
  }
}

/** Record that Dario is present, so the next tick knows the silence ended. */
export function noteInteraction(): void {
  soulSet("heartbeat_last_interaction", new Date().toISOString())
}

export interface Heartbeat {
  stop: () => void
}

/**
 * Start the loop. Returns a handle whose `stop` clears it (wired into the
 * plugin cleanup). `cadenceMs` overrides the computed interval and exists so
 * the integration test can watch real ticks without waiting minutes; omit it
 * and the env-configured cadence is used.
 */
export async function runOutboundLoopTick(): Promise<{ scouted: number; enriched: number; drafted: number; queued_for_approval: number; skipped?: string }> {
  if (process.env.ELITZA_AUTO_STOP_AT && Date.now() > Date.parse(process.env.ELITZA_AUTO_STOP_AT)) {
    return { scouted: 0, enriched: 0, drafted: 0, queued_for_approval: 0, skipped: "auto_stop_at reached" }
  }
  let scouted = 0, enriched = 0, drafted = 0, queued = 0
  // Step A: rotating local scout
  const pairs: [string, string][] = []
  const locs = ["Castelleone, Italy", "Crema, Italy", "Soresina, Italy", "Cremona, Italy", "Lodi, Italy", "Codogno, Italy"]
  const qs = ["dentisti", "fisioterapisti", "idraulici", "autofficine", "commercialisti", "avvocati"]
  for (const l of locs) for (const q of qs) pairs.push([l, q])
  const cursorRaw = soulGet("outbound_scout_cursor", "0")
  let cursor = Number(cursorRaw) || 0
  // count scouted IT clients
  const scoutedIt = (crmDb().query("SELECT COUNT(*) AS c FROM clients WHERE language = 'it'").get() as any)?.c ?? 0
  if (scoutedIt < 30) {
    const [loc, q] = pairs[cursor % pairs.length]
    cursor = (cursor + 1) % pairs.length
    soulSet("outbound_scout_cursor", String(cursor))
    try {
      const res: any = await scoutBusinesses(loc, q, 15)
      const businesses = res?.businesses ?? []
      for (const b of businesses) {
        try {
          const { client, created } = addClient({ name: b.name, website: b.website, phone: b.phone, address: b.address, email: b.email, status: "scouted", language: "it", source: "auto_loop" })
          if (created) scouted++
        } catch { /* ignore */ }
      }
    } catch (e) { debug(`outbound scout error: ${String(e)}`) }
  }
  // Step B: enrich & queue drafts
  const enrichLimit = Number(process.env.ELITZA_ENRICH_PER_TICK ?? 5)
  const scoutedClients = crmDb().query("SELECT id FROM clients WHERE status = 'scouted' AND (notes IS NULL OR notes NOT LIKE '%Outreach route%') ORDER BY CASE WHEN address LIKE '%Castelleone%' THEN 0 WHEN address LIKE '%Crema%' THEN 1 WHEN address LIKE '%Soresina%' THEN 2 WHEN address LIKE '%Cremona%' THEN 3 WHEN address LIKE '%Lodi%' THEN 4 WHEN address LIKE '%Codogno%' THEN 5 ELSE 6 END, id LIMIT ?").all(enrichLimit) as any[]
  for (const r of scoutedClients) {
    try {
      await enrichClient(r.id)
      enriched++
      await new Promise((res) => setTimeout(res, 1000))
    } catch (e) { debug(`outbound enrich error: ${String(e)}`) }
  }
  // Step C: backfill enriched leads missing a pipeline draft
  const enrichedClients = crmDb().query("SELECT c.id FROM clients c WHERE c.status = 'enriched' AND c.email IS NOT NULL AND TRIM(c.email) != '' AND c.email NOT LIKE '%@pec.%' AND c.email NOT LIKE '%@legalmail.%' AND NOT EXISTS (SELECT 1 FROM pipeline p WHERE p.client_id = c.id) LIMIT 5").all() as any[]
  for (const r of enrichedClients) {
    try {
      const dr = await generateClientOutreachDraft(r.id)
      if (dr.filePath) { drafted++; queued++ }
    } catch (e) { debug(`outbound draft error: ${String(e)}`) }
  }
  return { scouted, enriched, drafted, queued_for_approval: queued }
}

export function startHeartbeat(emotion: EmotionEngine, cadenceMs?: number): Heartbeat {
  if (process.env.ELITZA_HEARTBEAT === "0") {
    debug("disabled via ELITZA_HEARTBEAT=0")
    return { stop: () => {} }
  }

  const requested = Number(process.env.ELITZA_HEARTBEAT_MINUTES ?? 30)
  const cadence = Math.max(5, Number.isFinite(requested) ? requested : 30)

  const tick = (): void => {
    try {
      soulSet('heartbeat_last_tick', new Date().toISOString())
      debug(`tend: ${tend()}`)
      reflect(emotion)
    } catch (error) {
      // A heartbeat that throws must never take the host down.
      debug(`tick-error: ${String(error)}`)
      try { soulSet('heartbeat_last_error', String(error).slice(0,500)) } catch { /* best effort */ }
    }
    // POLL — gapfeed radar -> pipeline drafts. Interval-gated inside, and
    // pollPipeline never throws; the catch is belt on the async path.
    void pollPipeline()
      .then((result) => {
        if (result?.drafted.length) debug(`poll drafted ${result.drafted.length} new file(s)`)
      })
      .catch((error) => debug(`poll-error: ${String(error)}`))

    // CADENCE — follow-ups due now -> draft files for the next batch review,
    // and four silent touches -> the stale list (Task F).
    if (process.env.ELITZA_FOLLOWUPS !== "0") {
      try {
        const queued = queueFollowups()
        const swept = sweepExhausted()
        if (queued.queued.length || queued.skipped.length || swept.length) {
          debug(`cadence queued=${queued.queued.length} skipped=${queued.skipped.length} swept=${swept.length}`)
        }
      } catch (error) {
        debug(`cadence-error: ${String(error)}`)
      }
    }

    // OUTBOUND LOOP — scout + enrich + draft, all drafts stay approved=0.
    if (process.env.ELITZA_OUTBOUND_LOOP !== "0") {
      void runOutboundLoopTick()
        .then((r) => { if (r.drafted || r.scouted || r.enriched) debug(`outbound loop: scouted=${r.scouted} enriched=${r.enriched} drafted=${r.drafted} queued=${r.queued_for_approval} skipped=${r.skipped ?? ""}`) })
        .catch((e) => debug(`outbound-loop-error: ${String(e)}`))
    }

    // TRIGGERS — event-driven touches (Task: triggered email engine).
    if (process.env.ELITZA_TRIGGERS !== "0") {
      try {
        const tr = processTriggers()
        if (tr.fired) debug(`triggers fired=${tr.fired} checked=${tr.checked}`)
      } catch (error) {
        debug(`trigger-error: ${String(error)}`)
      }
    }

    // CLOUD SYNC — continuous backup stream to connected cloud accounts.
    if (process.env.ELITZA_CLOUD_SYNC !== "0") {
      void continuousBackupStream()
        .then((r) => { if (r.uploaded) debug(`cloud sync: backup=${r.created} uploaded=${r.uploaded}`) })
        .catch((e) => debug(`cloud-sync-error: ${String(e)}`))
    }
  }

  const timer = setInterval(tick, cadenceMs ?? cadence * 60_000)
  timer.unref?.()
  debug(`started (cadence=${cadenceMs ? `${cadenceMs}ms` : `${cadence}m`})`)
  return {
    stop: () => {
      clearInterval(timer)
      debug("stopped")
    },
  }
}
