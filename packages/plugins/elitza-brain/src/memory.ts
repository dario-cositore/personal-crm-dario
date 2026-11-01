/**
 * AI Enablement Agent — memory (minimal).
 *
 * Minimal memory implementation for the CRM tool.
 * No emotion, no learning, no companion features.
 * Just basic storage and recall backed by soul_v2.db.
 */

import { db, nowISO, BRAIN_DIR } from "./db.js"
import fs from "node:fs"
import path from "node:path"

export interface Memory {
  id: string
  memory_type: string
  content: string
  summary: string
  importance: number
  created: string
  mood?: string
}

export function recall(query?: string, opts: { limit?: number; memoryType?: string } = {}): Memory[] {
  const limit = opts.limit ?? 10
  const conn = db()
  const columns = "id, memory_type, content, summary, importance, created"
  let rows: any[] = []

  if (query) {
    try {
      const tokens = query.split(/\s+/).filter(Boolean).slice(0, 5).map((w) => `"${w.replace(/"/g, '""')}"`)
      const ftsQuery = tokens.join(" OR ")
      rows = conn.query(`SELECT ${columns} FROM memories WHERE rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?) ORDER BY importance DESC, created DESC LIMIT ?`).all(ftsQuery, limit * 2)
    } catch {
      const likePattern = `%${query}%`
      rows = conn.query(`SELECT ${columns} FROM memories WHERE (content LIKE ? OR summary LIKE ?) ORDER BY importance DESC, created DESC LIMIT ?`).all(likePattern, likePattern, limit * 2)
    }
  } else {
    rows = conn.query(`SELECT ${columns} FROM memories ORDER BY importance DESC, created DESC LIMIT ?`).all(limit * 2)
  }

  return rows.map((r: any) => ({
    id: r.id,
    memory_type: r.memory_type,
    content: r.content,
    summary: r.summary,
    importance: r.importance,
    created: r.created,
  }))
}

export function memorySearch(query: string, memoryType?: string, limit = 10): string {
  const results = recall(query, { limit, memoryType })
  return results.map((m) => `[${m.memory_type}] ${m.content}`).join("\n")
}

export function memoryCreate(content: string, opts: { memoryType?: string; importance?: number; tags?: string[] } = {}): string {
  const conn = db()
  const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = nowISO()
  const summary = content.length > 200 ? content.slice(0, 200) : content
  conn.run(
    `INSERT INTO memories (id, memory_type, content, summary, importance, created, decay_rate, confidence) VALUES (?, ?, ?, ?, ?, ?, 0.003, 0.8)`,
    [id, opts.memoryType ?? "semantic", content, summary, opts.importance ?? 0.5, now],
  )
  try {
    conn.run(
      `INSERT INTO memories_fts(rowid, content, summary, tags, context) VALUES (last_insert_rowid(), ?, ?, ?, ?)`,
      [content, summary, (opts.tags ?? []).join(" "), "{}"],
    )
  } catch {
    // FTS indexing is best-effort.
  }
  return id
}

export function memoryForget(query: string): string {
  const conn = db()
  conn.run("DELETE FROM memories WHERE content LIKE ? OR summary LIKE ?", [`%${query}%`, `%${query}%`])
  return `Forgot memories matching: ${query}`
}

export function getLearningStats(): { skills: number; knowledge: number; lessons: number } {
  return { skills: 0, knowledge: 0, lessons: 0 }
}

export function memoryStats(): string {
  const conn = db()
  const count = conn.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }
  return `Total memories: ${count.c}`
}

export function memoryConsolidate(): string {
  return "Consolidation not needed for CRM tool"
}

export function consolidate(): number { return 0 }
export function getMetamemory(): { totalMemories: number } { 
  const conn = db()
  const count = conn.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }
  return { totalMemories: count.c }
}
export function listProceduralSkills(): { name: string; description: string; path: string }[] {
  const dir = path.join(BRAIN_DIR, "procedural")
  if (!fs.existsSync(dir)) return []
  const out: { name: string; description: string; path: string }[] = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue
    const fullPath = path.join(dir, file)
    const raw = fs.readFileSync(fullPath, "utf8")
    const fm = raw.match(/^---\n([\s\S]*?)\n---/)
    const body = fm ? fm[1] : ""
    const nameMatch = body.match(/^name:\s*(.*)$/m)
    const descMatch = body.match(/^description:\s*(.*)$/m)
    out.push({
      name: nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, "") : file.replace(/\.md$/, ""),
      description: descMatch ? descMatch[1].trim().replace(/^['"]|['"]$/g, "") : "",
      path: fullPath,
    })
  }
  return out
}
export function pruneAll(): number { return 0 }

export function autoRememberTurn(_role: string, _content: string, _success = true): void {}
export function autoLearnFromResponse(_response: string): void {}
export function extractTags(content: string): string[] { return [] }
export function storeEpisodic(content: string, opts: any = {}): string { return memoryCreate(content, { memoryType: "episodic", ...opts }) }
export function storeSemantic(content: string, opts: any = {}): string { return memoryCreate(content, { memoryType: "semantic", ...opts }) }
export function storeProcedural(name: string, steps: string[], context: string, importance: number): string { return memoryCreate(`[PROCEDURAL] ${name}: ${steps.join(", ")}`, { memoryType: "procedural", importance }) }
export function storeEmotional(event: string, valence: number, arousal: number, mood: string, source: string): string { return memoryCreate(`[EMOTIONAL] ${event}`, { memoryType: "emotional", importance: 0.5 }) }
