// Elitza Brain — Google Calendar booking from email reasoning
import { getClient, updateClient, logInteraction } from "./crm.js"

function nowRomeISO(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Europe/Rome" }).replace(" ", "T")
}

async function resolveBeamKey(): Promise<string> {
  let apiKey = process.env.OPENCODE_API_KEY?.trim() || ""
  if (apiKey) return apiKey
  try {
    const Database = (await import("bun:sqlite")).default
    const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
    const db = new (Database as any)(dbPath, { readonly: true })
    const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
    if (row?.value) {
      const cred = JSON.parse(row.value)
      if (cred.access) apiKey = cred.access
    }
    db.close()
  } catch { /* ignore */ }
  return apiKey
}

export interface MeetingExtraction {
  meeting_confirmed: boolean
  startISO?: string
  endISO?: string
  summary?: string
}

export async function extractAndBookMeeting(email: any, client: any, recentThread?: string): Promise<MeetingExtraction> {
  const apiKey = await resolveBeamKey()
  if (!apiKey) return { meeting_confirmed: false }
  const now = nowRomeISO()
  const prompt = `Current date/time in Europe/Rome: ${now}. Analyze this email reply and determine if a meeting/call was proposed or confirmed. Output ONLY JSON: {"meeting_confirmed":true/false,"startISO":"ISO datetime with offset","endISO":"ISO datetime with offset","summary":"short"}.

Email subject: ${email?.subject ?? ""}
Email body: ${email?.body ?? email?.snippet ?? ""}
Client: ${client?.name ?? ""}
Recent thread: ${recentThread ?? ""}`

  let content = ""
  try {
    const res = await fetch("https://opencode.ai/inference/go/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: "beam-free",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        max_tokens: 4096,
        reasoning_effort: "low",
      }),
    })
    if (res.ok) {
      const data: any = await res.json()
      content = data?.choices?.[0]?.message?.content || ""
      if (!content.trim()) {
        const rc = data?.choices?.[0]?.message?.reasoning_content || ""
        const m = rc.match(/\{[\s\S]*\}/)
        if (m) content = m[0]
      }
    }
  } catch { /* ignore */ }

  let parsed: any = {}
  try { parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || content) } catch { parsed = {} }

  const result: MeetingExtraction = {
    meeting_confirmed: !!parsed.meeting_confirmed,
    startISO: parsed.startISO,
    endISO: parsed.endISO,
    summary: parsed.summary,
  }

  if (result.meeting_confirmed && result.startISO) {
    // create calendar event if token available
    const token = process.env.GOOGLE_ACCESS_TOKEN || ""
    const offer = client?.offer_track || ""
    const title = `Call Operativa — ${client?.name ?? ""} (${offer})`
    const desc = `Client phone: ${client?.phone ?? "n/a"}\nOffer: ${offer}\n\nCall Playbook questions attached.`
    if (token) {
      try {
        await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
          body: JSON.stringify({
            summary: title,
            description: desc,
            start: { dateTime: result.startISO },
            end: { dateTime: result.endISO || result.startISO },
            attendees: client?.email ? [{ email: client.email }] : [],
          }),
        })
      } catch { /* ignore */ }
    }
    try {
      updateClient(client.id, { status: "scheduled", next_action_at: result.startISO, next_action: `Call fissata: ${result.startISO}` })
      logInteraction(client.id, { kind: "meeting_scheduled", direction: "note", channel: "calendar", status: "completed", subject: title, body: `Start: ${result.startISO}`, occurred_at: new Date().toISOString() })
    } catch { /* ignore */ }
  }

  return result
}