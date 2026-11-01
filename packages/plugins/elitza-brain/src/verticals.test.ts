import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-vert-test-"))
process.env.ELITZA_HOME = home

const { seedVerticals, listVerticals, getVertical, setActiveVertical, getActiveVertical } = await import("./verticals.js")

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe("verticals", () => {
  test("seed creates farming and trades", () => {
    const seeded = seedVerticals()
    expect(seeded).toContain("farming")
    expect(seeded).toContain("trades")
    expect(listVerticals()).toContain("farming")
  })

  test("seed is idempotent", () => {
    const seeded = seedVerticals()
    expect(seeded).toEqual([])
  })

  test("getVertical returns pack", () => {
    const v = getVertical("farming")
    expect(v?.name).toBe("farming")
    expect(v?.scout_queries.length).toBeGreaterThan(0)
  })

  test("setActiveVertical", () => {
    expect(setActiveVertical("farming")).toBe(true)
    expect(getActiveVertical()).toBe("farming")
    expect(setActiveVertical("nope")).toBe(false)
  })
})
