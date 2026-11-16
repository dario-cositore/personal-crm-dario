import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-referral-test-"))
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")

const crm = await import("./crm.js")

if (!crm.crmDbPath().startsWith(home)) throw new Error(`refusing to run against ${crm.crmDbPath()}`)

afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe("referral program", () => {
  test("add referrer + event awards points and badge", () => {
    const r = crm.addReferrer({ name: "Bob", birthday: "2026-11-20" })
    expect(r.id).toBe(1)
    expect(r.tier).toBe("bronze")
    const ev = crm.addReferralEvent({ referrer_id: r.id, event_type: "referral", value: 100 })
    expect(ev.points).toBe(10)
    const r2 = crm.getReferrer(r.id)!
    expect(r2.points).toBe(10)
    expect(JSON.parse(r2.badges!)).toContain("first_referral")
  })
  test("tier upgrades to silver at 3 referrals", () => {
    const r = crm.addReferrer({ name: "Carol" })
    for (let i = 0; i < 3; i++) crm.addReferralEvent({ referrer_id: r.id, event_type: "referral" })
    const r2 = crm.getReferrer(r.id)!
    expect(r2.tier).toBe("silver")
  })
  test("thank you lifecycle", () => {
    const r = crm.addReferrer({ name: "Dan" })
    const t = crm.addThankYou({ referrer_id: r.id, subject: "Hi", body: "Thanks" })
    expect(t.status).toBe("draft")
    const u = crm.updateThankYou(t.id, { status: "sent", sent_at: new Date().toISOString() })
    expect(u!.status).toBe("sent")
    expect(crm.getReferrer(r.id)!.last_thank_you_at).toBeTruthy()
  })
  test("dashboard aggregates", () => {
    const d = crm.referralDashboard()
    expect(d.total_referrers).toBeGreaterThan(0)
    expect(d).toHaveProperty("by_tier")
    expect(d).toHaveProperty("upcoming_birthdays")
  })
  test("leaderboard + birthdays", () => {
    expect(Array.isArray(crm.referralLeaderboard(5))).toBe(true)
    expect(Array.isArray(crm.upcomingReferrerBirthdays(30))).toBe(true)
  })
  test("delete event subtracts points", () => {
    const r = crm.addReferrer({ name: "Eve" })
    const ev = crm.addReferralEvent({ referrer_id: r.id, event_type: "referral" })
    const before = crm.getReferrer(r.id)!.points
    crm.deleteReferralEvent(ev.id)
    const after = crm.getReferrer(r.id)!.points
    expect(after).toBe(before - ev.points)
  })
})