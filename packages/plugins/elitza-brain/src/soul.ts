/**
 * AI Enablement Agent — soul (minimal).
 *
 * Minimal soul implementation for the CRM tool.
 * No personality, no emotion, no companion features.
 * Just key-value storage backed by soul_v2.db.
 */

import { db, nowISO } from "./db.js"

export function soulGet(key: string, dflt = ""): string {
  const row = db().query("SELECT value FROM soul WHERE key=?").get(key) as { value: string } | null
  return row ? row.value : dflt
}

export function soulSet(key: string, value: string): void {
  db().run(
    "INSERT OR REPLACE INTO soul (key, value, updated) VALUES (?, ?, ?)",
    [key, value, nowISO()],
  )
}

export interface Personality {
  name: string
  model: string
  mood: string
  style: string
  confidence?: number
  interactions?: number
  emotional_state?: Record<string, unknown>
  preferences?: Record<string, number>
  opinions?: Record<string, unknown>
  learnings?: { what: string; context?: string }[]
}

export function getPersonality(): Personality {
  return {
    name: "AI Enablement Agent",
    model: soulGet("model", "default"),
    mood: "neutral",
    style: "direct, efficient, task-focused",
  }
}

export function evolveSoul(_userText: string, _response: string, _tools: string[], _success: boolean): void {
  // No-op for CRM tool
}
