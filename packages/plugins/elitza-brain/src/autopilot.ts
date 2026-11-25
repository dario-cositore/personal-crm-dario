/**
 * Elitza Brain — one-button Case Autopilot.
 */

import { getClient, updateClient, addDeal, listDeals, addTrigger } from "./crm.js"
import { enrichClient } from "./enrichment.js"
import { routeAndPersist, routeClientTrack } from "./routing.js"
import { resolvePlaybook, renderPlaceholders } from "./playbooks.js"
import { instantiateTemplate } from "./templates.js"
import { writeDraft, generateClientOutreachDraft } from "./outreach.js"
import { nowISO } from "./db.js"

function _dbg(m: string) { const a = (globalThis as any).__debugLogs; if (Array.isArray(a)) a.push({ ts: new Date().toISOString(), msg: m }) }

export async function runCaseAutopilot(clientId: number, opts?: { onProgress?: (line: string) => void }): Promise<any> {
  const log = (m: string) => { try { opts?.onProgress?.(m) } catch {}; _dbg(m) }
  const client0 = getClient(clientId)
  if (!client0) throw new Error(`No client with id ${clientId}.`)

  log("Autopilot: loaded client " + client0.name)
  // Enrich if not enriched.
  if (!client0.status || client0.status === "scouted" || client0.status === "new") {
    log("Autopilot: enriching (status=" + (client0.status || "none") + ")...")
    try { await enrichClient(clientId, { onProgress: (l) => log("  " + l) }) } catch (e) { log("Autopilot: enrich error " + String(e)); /* best effort */ }
  } else {
    log("Autopilot: already enriched (status=" + client0.status + "), skipping enrich")
  }

  const client = getClient(clientId)!
  log("Autopilot: resolving offer track (current=" + (client.offer_track || "none") + ")")
  // Resolve track + persist only if not already set by enrichment.
  const { track, pricing } = client.offer_track
    ? routeClientTrack(client)
    : routeAndPersist(clientId)
  const updatedClient = getClient(clientId)!
  log("Autopilot: track=" + track + " price=" + pricing.setup_price)

  // Resolve playbook.
  const pb = resolvePlaybook(clientId)
  const playbookId = pb?.id ?? null
  if (playbookId) updateClient(clientId, { playbook_id: playbookId })
  const finalClient = getClient(clientId)!
  log("Autopilot: playbook=" + (playbookId || "none") + " stage=" + (updatedClient.status || "scouted"))

  // Determine stage.
  const stage = updatedClient.status || "scouted"
  const stagePb = pb?.stages?.[stage] ?? pb?.stages?.["scouted"]

  // Instantiate templates.
  const stagedAssets: string[] = []
  if (stagePb?.auto_bundle?.templates) {
    for (const t of stagePb.auto_bundle.templates) {
      const res = instantiateTemplate(t, clientId)
      if (res) stagedAssets.push(res.dir)
    }
  }
  // Triggers.
  if (stagePb?.auto_bundle?.triggers) {
    for (const tr of stagePb.auto_bundle.triggers) {
      try { addTrigger(clientId, { name: tr.name, event: tr.event, subject: tr.subject, body: tr.body, cooldown_days: tr.cooldown_days }) } catch { /* best effort */ }
    }
  }

  // Deal row.
  let deal: any = null
  try {
    const deals = listDeals(clientId)
    if (deals && deals.length) {
      deal = deals[0]
    } else {
      deal = addDeal(clientId, { title: `${pricing.track_name} — ${updatedClient.name}`, value: 0, currency: pricing.currency === "EUR" ? "EUR" : "USD", stage: "open", notes: pricing.lines.join("; ") })
    }
  } catch { /* best effort */ }

  // Write primary email draft (unapproved) via LLM.
  let draftPath: string | null = null
  try {
    log("Autopilot: generating email draft via LLM...")
    const r = await generateClientOutreachDraft(clientId)
    draftPath = r.filePath ?? null
    if (r.skipped) log("Autopilot: draft skipped -> " + r.skipped)
    else log("Autopilot: draft written -> " + (draftPath || "(none)"))
  } catch (e) { log("Autopilot: draft error " + String(e)); console.error("[autopilot] draft error:", String(e)) }

  const doNow = stagePb?.what_to_do ?? []
  const sayThis = stagePb?.what_to_say ?? []
  const neverSay = stagePb?.what_not_to_say ?? []
  const objections = stagePb?.objection_handlers ?? []

  return {
    client: finalClient,
    track,
    pricing,
    stage,
    do_now: doNow,
    say_this: sayThis,
    never_say: neverSay,
    objections,
    staged_assets: stagedAssets,
    deal,
    draft_path: draftPath,
  }
}
