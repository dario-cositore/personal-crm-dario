import { describe, expect, test } from "bun:test"
import { CATEGORY_TAGS } from "./scouting.js"

function tagsFor(query: string): string[][] {
  const q = query.toLowerCase()
  const words = q.split(/\s+/)
  const out: string[][] = []
  for (const entry of CATEGORY_TAGS) {
    const matched = entry.match.some((m: string) => {
      if (m.includes(" ")) return q.includes(m)
      return words.includes(m)
    })
    if (matched) out.push(...entry.tags)
  }
  return out
}

describe("CATEGORY_TAGS new verticals", () => {
  test("immobiliare maps to estate_agent", () => {
    const tags = tagsFor("immobiliare")
    expect(tags).toContainEqual(["office", "estate_agent"])
  })
  test("architetti maps to architect/engineer", () => {
    const tags = tagsFor("architetti")
    expect(tags).toContainEqual(["office", "architect"])
  })
  test("logistica maps to logistics/transport", () => {
    const tags = tagsFor("logistica")
    expect(tags).toContainEqual(["office", "logistics"])
  })
})
