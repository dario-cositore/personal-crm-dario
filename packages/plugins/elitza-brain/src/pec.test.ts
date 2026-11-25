import { afterEach, describe, expect, test } from "bun:test"
import { discoverEmail } from "./scouting.js"
import { extractEmails } from "./enrichment.js"

const servers: { stop: (force?: boolean) => void }[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop(true) })
function serve(html: string) {
  const srv = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) })
  servers.push(srv)
  return `http://127.0.0.1:${srv.port}`
}

describe("PEC / junk email filtering", () => {
  test("discoverEmail rejects pec addresses", async () => {
    const url = serve('<html><body>pec@pec.it legal@legalmail.it noreply@x.com mailer-daemon@y.com ok@real.example</body></html>')
    const email = await discoverEmail(url)
    expect(email).toBe("ok@real.example")
  })
  test("extractEmails rejects pec addresses", () => {
    const out = extractEmails("a@pec.it b@legalmail.it c@telecompost.it d@arubapec.it e@postacert.it f@certmail.it g@noreply.com h@no-reply.com i@mailer-daemon.com j@real.example")
    expect(out).toEqual(["j@real.example"])
  })
})
