// Elitza Brain — Telegram notifications
import fs from "node:fs"
import path from "node:path"

function readEnv(): Record<string, string> {
  const home = (process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) || (process.env.HOME || "") + "/.ai-enablement-agent"
  const envPath = path.join(home, ".env")
  const out: Record<string, string> = {}
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq < 0) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[k] = v
    }
  } catch { /* ignore */ }
  return out
}

export function getTelegramConfig(): { token: string; chatId: string } {
  const env = readEnv()
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || "",
  }
}

export async function sendTelegram(text: string): Promise<{ ok: boolean; error?: string }> {
  const { token, chatId } = getTelegramConfig()
  if (!token || !chatId) return { ok: false, error: "Telegram not configured" }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function testTelegram(): Promise<{ ok: boolean; error?: string }> {
  return sendTelegram("Elitza Telegram test: connection OK.")
}

export function buildTelegramAlert(payload: { clientName: string; vertical?: string | null; offer?: string | null; snippet?: string | null; calendarStatus?: string | null; link?: string | null }): string {
  const lines = [
    `<b>${payload.clientName}</b> replied`,
    payload.vertical ? `Vertical: ${payload.vertical}` : "",
    payload.offer ? `Offer: ${payload.offer}` : "",
    payload.snippet ? `Reply: ${payload.snippet.slice(0, 300)}` : "",
    payload.calendarStatus ? `Calendar: ${payload.calendarStatus}` : "",
    payload.link ? `Link: ${payload.link}` : "",
  ].filter(Boolean)
  return lines.join("\n")
}