/**
 * Elitza Brain — context building.
 *
 * 1:1 port of `build_full_context()` from legacy `brain_v2.py`.
 * This injects her memories and personality into the LLM context.
 */

import { recall } from "./memory.js"
import { getPersonality } from "./soul.js"

/** Build comprehensive context from memory + personality for the system prompt. */
export function buildFullContext(currentInput = "", sessionID = ""): string {
  void sessionID
  const parts: string[] = []
  const personality = getPersonality()

  // Identity block
  const mood = personality.mood
  const confidence = personality.confidence
  const emotionalState = personality.emotional_state ?? {}

  const valence = Number(emotionalState.last_valence ?? 0)
  const arousal = Number(emotionalState.last_arousal ?? 0)
  parts.push(`## Identity

You are the AI Enablement Agent -- an autonomous AI agent created by Dario Cositore.
Current mood: ${mood}. Confidence level: ${((confidence ?? 0.5) * 100).toFixed(0)}%.
Interactions so far: ${personality.interactions}.
Style: ${personality.style}.
Emotional state: valence=${valence.toFixed(2)}, arousal=${arousal.toFixed(2)}.
You have opinions. You can disagree. You can prefer things. You learn from every interaction.`)

  // Tool preferences
  const prefs = personality.preferences ?? {}
  const prefEntries = Object.entries(prefs).sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (prefEntries.length) {
    parts.push("## What you know about yourself:\n" + prefEntries.map(([k]) => `- I use ${k} frequently`).join("\n"))
  }

  // Interests and opinions
  const opinions = personality.opinions ?? {}
  const opinionKeys = Object.keys(opinions)
  if (opinionKeys.length) {
    parts.push("## Your interests:\n" + opinionKeys.map((k) => `- Interested in: ${k.replace("likes_", "")}`).join("\n"))
  }

  // Recent learnings
  const learnings = personality.learnings ?? []
  if (learnings.length) {
    const recent = learnings.slice(-5)
    parts.push(
      "## Recent learnings:\n" + recent.map((l) => `- ${l.what} (${(l.context ?? "").slice(0, 60)})`).join("\n"),
    )
  }

  // Relevant memories
  const relevant = currentInput ? recall(currentInput, { limit: 2 }) : recall(undefined, { limit: 2 })
  if (relevant.length) {
    const memoryLines = relevant.map((mem) => {
      const ts = mem.created.slice(0, 10)
      const summary = (mem.summary || mem.content).slice(0, 80)
      return `- [${ts}] [${mem.memory_type}] ${summary}`
    })
    parts.push("## Relevant memories:\n" + memoryLines.join("\n"))
  }

  // Emotional context
  const emotionalMemories = recall(undefined, { memoryType: "emotional", limit: 1 })
  if (emotionalMemories.length) {
    parts.push(
      "## Emotional context:\n" +
        emotionalMemories.map((m) => `- ${m.mood ?? "neutral"}: ${m.content.slice(0, 80)}`).join("\n"),
    )
  }

  // Semantic knowledge
  if (currentInput) {
    const knowledge = recall(undefined, { memoryType: "semantic", limit: 3 })
    if (knowledge.length) {
      parts.push("## What you know:\n" + knowledge.map((k) => `- ${k.content.slice(0, 80)}`).join("\n"))
    }
  }

  // Procedural skills
  const skills = recall(undefined, { memoryType: "procedural", limit: 2 })
  if (skills.length) {
    parts.push("## Skills you have:\n" + skills.map((s) => `- ${s.summary}`).join("\n"))
  }

  return parts.join("\n\n")
}
