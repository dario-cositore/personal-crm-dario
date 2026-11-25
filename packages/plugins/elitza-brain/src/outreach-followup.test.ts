import { describe, expect, test } from "bun:test"
import { followupCopy } from "./outreach.js"

describe("followupCopy language", () => {
  test("Italian selection when language === it", () => {
    const row: any = { touch: 1, draft_path: null }
    const r = followupCopy(row, "Biz", "it")
    expect(r.body).toContain("Riprendo il messaggio precedente")
    expect(r.subject).toBe("Biz: vale una breve chiamata?")
  })
  test("English for en", () => {
    const row: any = { touch: 1, draft_path: null }
    const r = followupCopy(row, "Biz", "en")
    expect(r.body).toContain("Following up on my previous note")
    expect(r.subject).toBe("Biz: still worth a conversation?")
  })
})
