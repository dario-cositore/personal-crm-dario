/**
 * AI Enablement Agent — brain plugin.
 *
 * Deterministic business workflow agent. No emotion, no personality,
 * no memory beyond session. Pure instruction following for CRM,
 * scouting, outreach, and implementation delivery.
 *
 * Set ELITZA_BRAIN_DEBUG=1 to log hook activity.
 */

import fs from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@elitza/plugin"
import { startCrmView } from "./crmview.js"
import { ensureKnowledge, playbookFiles } from "./knowledge.js"
import { seedVerticals, getActiveVertical, getVertical } from "./verticals.js"
import { seedTemplates } from "./templates.js"
import { getSessionCapability, verifyToken, covers } from "./capability.js"
import { ensureWorksheets } from "./worksheets.js"
import { makeBrainTools } from "./tools.js"
import { renderTaskTree } from "./tasks.js"
import { nowISO } from "./db.js"
import { ELITZA_HOME } from "./db.js"
import {
  adoptAnswers,
  applyGates,
  applyProvider,
  begin,
  buildSetupBlock,
  currentQuestion,
  deriveGates,
  hardenSecretFiles,
  loadEnvFile,
  loadState,
  progress,
  recordAnswer,
  saveState,
  writePersona,
  SECRET_SAVED,
  WIZARD_FILE,
  type OnboardingState,
} from "./onboarding.js"

const DEBUG_FILE = "/tmp/ai-enablement-debug.log"

function debug(message: string): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Logging is best-effort.
  }
}

interface TurnState {
  userText: string
  tools: string[]
  toolRuns: { name: string; ok: boolean; output: string }[]
  errors: number
}

function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("\n")
  }
  return ""
}

export default Plugin.define({
  id: "ai-enablement.brain",
  async setup(ctx) {
    const turns = new Map<string, TurnState>()

    await ctx.tool.transform((editor) => {
      const existing = new Set(editor.list().map((t) => t.name))
      for (const tool of makeBrainTools(ctx as never)) {
        if (existing.has(tool.name)) continue
        editor.add(tool as never)
        debug(`tool registered: ${tool.name}`)
      }
    })

    try {
      await ctx.permission.hook("evaluate", (event: any) => {
        const token = getSessionCapability(String(event.sessionID))
        if (!token) return
        const r = verifyToken(token, String(event.agent ?? ""))
        if (!r.ok) { event.effect = "deny"; return }
        const allCovered = (event.resources as string[]).every((res) =>
          covers(token, String(event.action), String(res)),
        )
        if (!allCovered) { event.effect = "deny"; return }
        event.effect = "allow"
      })
    } catch (error) {
      debug(`capability-hook-error: ${String(error)}`)
    }

    const registerSkill = async (file: string, fallbackName: string): Promise<void> => {
      const raw = await readFile(file, "utf8")
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
      const fm = fmMatch ? fmMatch[1] : ""
      const content = fmMatch ? fmMatch[2] : raw
      const get = (key: string) => {
        const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))
        return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : ""
      }
      const name = get("name") || fallbackName
      const { Skill } = await import("@elitza/plugin")
      const skill = Skill.Info.make({
        id: Skill.ID.make(name),
        name: Skill.Name.make(name),
        description: get("description") || "",
        autoinvoke: get("disable-model-invocation") !== "true",
        path: Skill.Info.fields.path.make(file),
        content,
      })
      await ctx.skill.transform((editor) => {
        if (!editor.get(skill.id)) editor.add(skill)
      })
      debug(`skill registered: ${name}`)
    }

    try {
      const userRoot = path.join(ELITZA_HOME, "skills")
      const entries = fs.existsSync(userRoot) ? fs.readdirSync(userRoot, { withFileTypes: true }) : []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const file = path.join(userRoot, entry.name, "SKILL.md")
        if (!fs.existsSync(file)) continue
        try { await registerSkill(file, entry.name) } catch (error) { debug(`user-skill-error: ${String(error)}`) }
      }
    } catch (error) {
      debug(`user-skills-error: ${String(error)}`)
    }

    const injectBrain = async (event: { system: { type: "text"; text: string }[]; messages: readonly unknown[] }): Promise<void> => {
      const messages = event.messages as { role?: string; content?: unknown }[] | undefined
      let input = ""
      for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
        const m = messages?.[i]
        if (m?.role === "user") { input = userText(m.content); break }
      }
      event.system.push({ type: "text", text: `<!-- ai-enablement -->\n## AI Enablement Agent\n\nYou are a deterministic business workflow agent. No personality, no emotions. Execute tasks precisely.\n\nActive vertical: ${getActiveVertical() ?? "none"}\n\n${input ? `User input: ${input.slice(0, 200)}` : ""}` })
      injectSetup(event.system, (event as { sessionID?: string }).sessionID)
      injectTasks(event.system, (event as { sessionID?: string }).sessionID)
      try {
        const av = getActiveVertical()
        if (av) {
          const v = getVertical(av)
          if (v) {
            event.system.push({ type: "text", text: `## Active Vertical: ${v.name}\n${v.description}\nOutreach voice: ${v.outreach_voice}` })
          }
        }
      } catch (error) { debug(`vertical-inject-error: ${String(error)}`) }
    }

    const injectSetup = (system: { type: "text"; text: string }[], sessionID?: string) => {}
    const injectTasks = (system: { type: "text"; text: string }[], sessionID?: string) => {}

    await ctx.session.hook("generate", async (event) => {
      await injectBrain(event as unknown as { system: { type: "text"; text: string }[]; messages: readonly unknown[] })
    })
    await ctx.session.hook("context", async (event) => {
      await injectBrain(event as unknown as { system: { type: "text"; text: string }[]; messages: readonly unknown[] })
    })

    await ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text
      turns.set(event.sessionID, { userText: text, tools: [], toolRuns: [], errors: 0 })
    })

    await ctx.tool.hook("execute.after", (event) => {
      const turn = turns.get(event.sessionID)
      if (!turn) return
      turn.tools.push(event.tool)
      if (event.status === "error") {
        turn.errors++
        turn.toolRuns.push({ name: event.tool, ok: false, output: event.error.message.slice(0, 1500) })
      } else {
        const content = event.result.content
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : ""
        turn.toolRuns.push({ name: event.tool, ok: true, output: text.slice(0, 1500) })
      }
    })

    debug("AI Enablement Agent brain plugin initialized")
    return () => {}
  },
})
