import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-ho-test-"))
process.env.AI_ENABLEMENT_HOME = home

const { generateHandover, verifyHandover } = await import("./handover.js")

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe("signed handover", () => {
  test("generate + verify round trip", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"))
    // init git repo
    const { execSync } = require("node:child_process")
    execSync("git init -q", { cwd: repo })
    fs.writeFileSync(path.join(repo, "a.txt"), "hi")
    execSync("git add a.txt && git commit -q -m init", { cwd: repo })
    const r = generateHandover({ repo })
    expect(r.signed).toBe(true)
    const v = verifyHandover(r.path)
    expect(v).toContain("RESULT: VALID")
  })

  test("tampered file is invalid", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo2-"))
    const { execSync } = require("node:child_process")
    execSync("git init -q", { cwd: repo })
    fs.writeFileSync(path.join(repo, "a.txt"), "hi")
    execSync("git add a.txt && git commit -q -m init", { cwd: repo })
    const r = generateHandover({ repo })
    fs.appendFileSync(r.path, "tampered\n")
    const v = verifyHandover(r.path)
    expect(v).toContain("RESULT: INVALID")
  })
})
