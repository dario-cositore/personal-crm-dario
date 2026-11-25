import type {
  DecisionMakerClue,
  EmailCandidate,
  FormAudit,
  FormFieldAudit,
  LocationClue,
  PdfSignal,
  VideoSignal,
  WebsiteIntelV2,
} from "./enrichment_types.js"
import { classifyEmailCandidate, selectBestEmails } from "./email_gate.js"

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
}

export interface CrawlAuditOptions {
  mode?: "scout_fast" | "deep_audit"
  businessName?: string | null
  transcribeVideoAudio?: boolean // Tier 3 opt-in ONLY (never enabled in enrichBatch)
  onProgress?: (msg: string) => void
}

type PageBucket =
| "home"
| "contact_intake"
| "booking_urgency"
| "team_governance"
| "locations"
| "services_docs"
| "legal_fallback"
| "other"

const NEGATIVE_PATH_RE =
/\/(?:blog|news|notizie|articoli|post|tag|tags|category|categoria|author|wp-json|wp-admin|wp-login|feed|rss|cart|carrello|checkout|my-account|shop\/page|product-category)\b/i
const BINARY_SKIP_RE =
/\.(?:jpg|jpeg|png|gif|webp|svg|ico|zip|rar|7z|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|woff|woff2|ttf|eot|css|js)$/i

const CONSENT_FORM_NOISE_RE = /iubenda|cookiebot|CybotCookiebot|cmplz|complianz|gdpr-cookie|moove_gdpr|cookie-law|borlabs/i
const BLOCKED_PDF_RE =
/privacy|cookie|gdpr|whistleblowing|modello.?231|codice.?etico|bilancio|condizioni.?generali|termini|note.?legali|informativa/i
const HIGH_SIGNAL_PDF_RE =
/carta.?dei.?servizi|modulistica|modulo|preparazione|consenso|tariffario|listino|convenzioni|assicurazion|brochure|presentazione|company.?profile|catalogo|prestazioni|servizi/i

const BOOKING_FINGERPRINTS: { name: string; re: RegExp; mode: "instant_slot" | "request_form" | "external_portal" }[] = [
  { name: "MioDottore", re: /miodottore\.it|zlwidget|docplanner/i, mode: "instant_slot" },
{ name: "Doctolib", re: /doctolib\.(?:it|fr|de|com)/i, mode: "instant_slot" },
{ name: "AlfaDocs", re: /alfadocs\.com/i, mode: "instant_slot" },
{ name: "Elty / DaVinci", re: /elty\.it|davincisalute/i, mode: "instant_slot" },
{ name: "CupSolidale", re: /cupsolidale\.it/i, mode: "instant_slot" },
{ name: "Calendly", re: /calendly\.com/i, mode: "instant_slot" },
{ name: "Cal.com", re: /\bcal\.com\//i, mode: "instant_slot" },
{ name: "Acuity Scheduling", re: /acuityscheduling\.com|squarespacescheduling/i, mode: "instant_slot" },
{ name: "Microsoft Bookings", re: /outlook\.office365\.com\/owa\/calendar/i, mode: "instant_slot" },
{ name: "Amelia Booking", re: /ameliabooking|wp-amelia/i, mode: "instant_slot" },
{ name: "Bookly", re: /bookly-main|bookly\.js/i, mode: "instant_slot" },
{ name: "Treatwell", re: /treatwell\.it/i, mode: "instant_slot" },
{ name: "Fresha", re: /fresha\.com/i, mode: "instant_slot" },
{ name: "TheFork", re: /thefork\.it|lafourchette/i, mode: "instant_slot" },
]

const CHAT_FINGERPRINTS: { name: string; re: RegExp }[] = [
  { name: "Tawk.to", re: /embed\.tawk\.to/i },
{ name: "Tidio", re: /code\.tidio\.co/i },
{ name: "Crisp", re: /client\.crisp\.chat/i },
{ name: "Intercom", re: /widget\.intercom\.io/i },
{ name: "Zendesk", re: /static\.zdassets\.com/i },
{ name: "LiveChat", re: /cdn\.livechatinc\.com/i },
{ name: "Smartsupp", re: /smartsuppchat\.com/i },
{ name: "HubSpot Chat", re: /js\.hs-scripts\.com|hubspotconversations/i },
{ name: "JivoChat", re: /code\.jivosite\.com/i },
{ name: "Userlike", re: /userlike-cdn/i },
{ name: "Callbell", re: /callbell\.eu/i },
]

const TECH_FINGERPRINTS: { name: string; re: RegExp }[] = [
  { name: "WordPress", re: /wp-content|wp-includes/i },
{ name: "Elementor", re: /elementor-section|elementor-widget/i },
{ name: "Divi", re: /et_pb_section|divi-custom/i },
{ name: "WPBakery", re: /vc_row|wpb_wrapper/i },
{ name: "WooCommerce", re: /woocommerce/i },
{ name: "Shopify", re: /cdn\.shopify\.com/i },
{ name: "PrestaShop", re: /prestashop/i },
{ name: "Wix", re: /wixstatic\.com|wix\.com/i },
{ name: "Squarespace", re: /squarespace\.com/i },
{ name: "Webflow", re: /webflow\.js|data-wf-site/i },
{ name: "HubSpot", re: /hsforms\.net|hs-scripts\.com/i },
{ name: "Google Tag Manager", re: /googletagmanager\.com\/gtm\.js/i },
{ name: "Meta Pixel", re: /connect\.facebook\.net\/.*\/fbevents\.js/i },
{ name: "Iubenda", re: /cdn\.iubenda\.com/i },
{ name: "Cookiebot", re: /consent\.cookiebot\.com/i },
{ name: "TeamSystem", re: /teamsystem/i },
{ name: "Zucchetti", re: /zucchetti/i },
]

function decodeEntities(raw: string): string {
  return raw
  .replace(/&#64;|&#x40;/gi, "@")
  .replace(/&#46;|&#x2e;/gi, ".")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#0?39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&agrave;/gi, "à")
  .replace(/&egrave;/gi, "è")
  .replace(/&eacute;/gi, "é")
  .replace(/&igrave;/gi, "ì")
  .replace(/&ograve;/gi, "ò")
  .replace(/&ugrave;/gi, "ù")
  .replace(/\s*\[\s*at\s*\]\s*|\s*\(\s*at\s*\)\s*/gi, "@")
  .replace(/\s*\[\s*dot\s*\]\s*|\s*\(\s*dot\s*\)\s*/gi, ".")
}

function decodeCloudflareEmailHex(hex: string): string | null {
  if (!hex || hex.length < 6 || hex.length % 2 !== 0) return null
    const key = parseInt(hex.slice(0, 2), 16)
    if (Number.isNaN(key)) return null
      let out = ""
      for (let i = 2; i < hex.length; i += 2) {
        const b = parseInt(hex.slice(i, i + 2), 16)
        if (Number.isNaN(b)) return null
          out += String.fromCharCode(b ^ key)
      }
      return out.includes("@") ? out.toLowerCase() : null
}

function stripTagsClean(html: string): string {
  return decodeEntities(
    html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:br|p|div|li|tr|h[1-6]|section|article|footer|header)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "),
  )
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim()
}

function decodeBufferWithCharset(buf: ArrayBuffer, contentTypeHeader: string): string {
  const bytes = new Uint8Array(buf.slice(0, 750_000))
  const headAscii = new TextDecoder("latin1").decode(bytes.slice(0, 4096))
  const headerCharset = /charset=([^\s;]+)/i.exec(contentTypeHeader)?.[1]?.replace(/["']/g, "")
  const metaCharset =
  /<meta[^>]+charset=["']?([a-zA-Z0-9_-]+)/i.exec(headAscii)?.[1] ||
  /<meta[^>]+content=["'][^"']*charset=([a-zA-Z0-9_-]+)/i.exec(headAscii)?.[1]
  const chosen = (headerCharset || metaCharset || "utf-8").toLowerCase()
  const label =
  chosen.includes("8859-1") || chosen.includes("1252") || chosen.includes("latin1")
  ? "windows-1252"
  : "utf-8"
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  }
}

function detectAntiBotChallenge(html: string, status: number, headers: Headers): boolean {
  if (headers.get("cf-mitigated") === "challenge") return true
    if ((status === 403 || status === 503 || status === 429) && html.length < 25_000) {
      if (/Just a moment\.\.\.|Attention Required! \| Cloudflare|Enable JavaScript and cookies to continue|cf-browser-verification/i.test(html)) {
        return true
      }
    }
    return false
}

async function fetchHtmlSmart(
  url: string,
  timeoutMs: number,
): Promise<{ html: string; finalUrl: string; antiBot: boolean } | null> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ct = res.headers.get("content-type") || ""
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return null
      const buf = await res.arrayBuffer()
      const html = decodeBufferWithCharset(buf, ct)
      if (detectAntiBotChallenge(html, res.status, res.headers)) {
        return { html: "", finalUrl: res.url || url, antiBot: true }
      }
      if (!res.ok) return null

        // Follow legacy HTML <meta http-equiv="refresh" content="0;url=...">
        if (html.length < 4000) {
          const refresh = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i.exec(html)?.[1]
          if (refresh) {
            try {
              const nextUrl = new URL(refresh, res.url || url).toString()
              if (nextUrl !== url) {
                const res2 = await fetch(nextUrl, {
                  headers: BROWSER_HEADERS,
                  redirect: "follow",
                  signal: AbortSignal.timeout(timeoutMs),
                })
                if (res2.ok) {
                  const buf2 = await res2.arrayBuffer()
                  return {
                    html: decodeBufferWithCharset(buf2, res2.headers.get("content-type") || ""),
                    finalUrl: res2.url || nextUrl,
                    antiBot: false,
                  }
                }
              }
            } catch {
              // ignore meta-refresh failure
            }
          }
        }
        return { html, finalUrl: res.url || url, antiBot: false }
  } catch {
    return null
  }
}

function scoreAndBucketLink(pathname: string, anchorText: string): { bucket: PageBucket; score: number } {
  const combined = `${pathname} ${anchorText}`.toLowerCase()
  if (NEGATIVE_PATH_RE.test(pathname)) return { bucket: "other", score: -100 }
  if (/privacy|cookie|note-legali|dati-societari|trasparenza|gdpr|termini/i.test(combined)) {
    return { bucket: "legal_fallback", score: 12 }
  }
  if (/contatt|contact|scrivici|preventiv|richiedi|quote|dove-siamo|recapiti/i.test(combined)) {
    return { bucket: "contact_intake", score: 55 }
  }
  if (/prenot|book|appuntament|orari|urgenz|pronto-intervento|accettazione/i.test(combined)) {
    return { bucket: "booking_urgency", score: 50 }
  }
  if (/chi-siamo|about|team|equipe|staff|medici|professionisti|avvocati|soci|dottori|studio|direttore/i.test(combined)) {
    return { bucket: "team_governance", score: 45 }
  }
  if (/\bsedi\b|ambulatori|filiali|uffici|locations|cliniche/i.test(combined)) {
    return { bucket: "locations", score: 42 }
  }
  if (/servizi|services|prestazioni|specialit|aree|modulistica|carta-dei-servizi|convenzion/i.test(combined)) {
    return { bucket: "services_docs", score: 34 }
  }
  return { bucket: "other", score: 5 }
}

function normalizeUrlKey(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ""
    const p = u.pathname.replace(/\/+$/, "") || "/"
    return `${u.hostname.replace(/^www\./i, "").toLowerCase()}${p}${u.search}`
  } catch {
    return raw.toLowerCase()
  }
}

async function fetchSitemapLinks(origin: string, timeoutMs = 2500): Promise<string[]> {
  const urls: string[] = []
  for (const pathCandidate of ["/sitemap.xml", "/wp-sitemap.xml", "/page-sitemap.xml"]) {
    try {
      const res = await fetch(`${origin}${pathCandidate}`, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) continue
        const xml = (await res.text()).slice(0, 250_000)
        for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          const loc = m[1].trim()
          if (loc && !loc.endsWith(".xml")) urls.push(loc)
        }
        if (urls.length > 0) break
    } catch {
      // ignore missing sitemap
    }
  }
  return urls.slice(0, 80)
}

interface PageDomExtract {
  title: string | null
  htmlLang: string | null
  hreflangs: string[]
  rawEmails: string[]
  telLinks: string[]
  whatsappLinks: { url: string; prefilled: string | null }[]
  socials: string[]
  internalLinks: { url: string; anchor: string }[]
  pdfLinks: { url: string; anchor: string }[]
  embedUrls: string[]
  videoTracks: string[]
  jsonLdBlocks: string[]
  forms: Omit<FormAudit, "evidence_id">[]
}

function inspectHtmlWithRewriter(html: string, pageUrl: string): PageDomExtract {
  const out: PageDomExtract = {
    title: null,
    htmlLang: null,
    hreflangs: [],
    rawEmails: [],
    telLinks: [],
    whatsappLinks: [],
    socials: [],
    internalLinks: [],
    pdfLinks: [],
    embedUrls: [],
    videoTracks: [],
    jsonLdBlocks: [],
    forms: [],
  }

  let rootOrigin = ""
  let rootHost = ""
  try {
    const u = new URL(pageUrl)
    rootOrigin = u.origin
    rootHost = u.hostname.replace(/^www\./i, "").toLowerCase()
  } catch {}

  let titleBuf = ""
  let currentLd = ""
  let currentAnchorHref = ""
  let currentAnchorText = ""

  interface RawFormDraft {
    attrs: string
    idOrName: string | null
    action: string
    fields: FormFieldAudit[]
    selectOptions: string[]
    submitLabel: string | null
    hasFile: boolean
    hasDate: boolean
    hasPassword: boolean
  }
  let activeForm: RawFormDraft | null = null
  let activeButtonText = ""
  let activeOptionText = ""

  const collectEmbedAttr = (el: HTMLRewriterTypes.Element) => {
    for (const attr of ["src", "data-src", "data-lazy-src", "data-cookieblock-src", "data-suppressedsrc", "data-url"]) {
      const val = el.getAttribute(attr)
      if (val && val.trim()) out.embedUrls.push(val.trim())
    }
  }

  const rewriter = new HTMLRewriter()
  .on("html", {
    element(el) {
      const l = el.getAttribute("lang")
      if (l) out.htmlLang = l.trim().toLowerCase()
    },
  })
  .on("title", {
    text(t) {
      titleBuf += t.text
    },
  })
  .on("link[rel='alternate'][hreflang]", {
    element(el) {
      const hl = el.getAttribute("hreflang")
      if (hl) out.hreflangs.push(hl.toLowerCase().slice(0, 5))
    },
  })
  .on("script[type='application/ld+json']", {
    text(t) {
      currentLd += t.text
      if (t.lastInTextNode) {
        if (currentLd.trim()) out.jsonLdBlocks.push(currentLd.trim())
          currentLd = ""
      }
    },
  })
  .on("iframe, embed, video, source, div[data-url], div[class*='zl-url'], a[class*='zl-url']", {
    element(el) {
      collectEmbedAttr(el)
    },
  })
  .on("track", {
    element(el) {
      const src = el.getAttribute("src")
      if (src && rootOrigin) {
        try {
          out.videoTracks.push(new URL(src, rootOrigin).toString())
        } catch {}
      }
    },
  })
  .on("[data-cfemail]", {
    element(el) {
      const hex = el.getAttribute("data-cfemail")
      if (hex) {
        const dec = decodeCloudflareEmailHex(hex)
        if (dec) out.rawEmails.push(dec)
      }
    },
  })
  .on("a", {
    element(el) {
      currentAnchorHref = (el.getAttribute("href") || "").trim()
      currentAnchorText = ""
    },
    text(t) {
      currentAnchorText += t.text
      if (t.lastInTextNode) {
        const href = currentAnchorHref
        const text = decodeEntities(currentAnchorText).replace(/\s+/g, " ").trim()
        if (href) {
          const cfIdx = href.indexOf("/cdn-cgi/l/email-protection#")
          if (cfIdx >= 0) {
            const dec = decodeCloudflareEmailHex(href.slice(cfIdx + 28).split(/[?&"']/)[0])
            if (dec) out.rawEmails.push(dec)
          } else if (/^mailto:/i.test(href)) {
            out.rawEmails.push(href.replace(/^mailto:\s*/i, "").split("?")[0])
          } else if (/^tel:/i.test(href)) {
            out.telLinks.push(href.replace(/^tel:\s*/i, "").trim())
          } else if (/wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/send/i.test(href)) {
            let prefilled: string | null = null
            try {
              const wu = new URL(href.startsWith("http") ? href : `https://${href}`)
              prefilled = wu.searchParams.get("text")
            } catch {}
            out.whatsappLinks.push({ url: href, prefilled })
          } else if (/(?:facebook|instagram|linkedin|youtube|vimeo|tiktok|twitter|x)\.com\//i.test(href)) {
            out.socials.push(href.split("?")[0].replace(/\/$/, ""))
            if (/youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d+/i.test(href)) {
              out.embedUrls.push(href)
            }
          } else if (rootOrigin && !/^(?:javascript:|#)/i.test(href)) {
            try {
              const resolved = new URL(href, rootOrigin)
              const host = resolved.hostname.replace(/^www\./i, "").toLowerCase()
              if (/\.pdf$/i.test(resolved.pathname) && host === rootHost) {
                out.pdfLinks.push({ url: resolved.toString(), anchor: text })
              } else if (host === rootHost && !BINARY_SKIP_RE.test(resolved.pathname)) {
                resolved.hash = ""
                out.internalLinks.push({ url: resolved.toString(), anchor: text })
              } else if (BOOKING_FINGERPRINTS.some((b) => b.re.test(resolved.toString()))) {
                out.embedUrls.push(resolved.toString())
              }
            } catch {}
          }
        }
        currentAnchorHref = ""
        currentAnchorText = ""
      }
    },
  })
  .on("form", {
    element(el) {
      const id = el.getAttribute("id") || ""
      const cls = el.getAttribute("class") || ""
      const name = el.getAttribute("name") || ""
      const action = el.getAttribute("action") || ""
      const role = el.getAttribute("role") || ""
      const attrs = `${id} ${cls} ${name} ${action} ${role}`
      if (role.toLowerCase() === "search" || CONSENT_FORM_NOISE_RE.test(attrs)) {
        activeForm = null
        return
      }
      activeForm = {
        attrs,
        idOrName: id || name || null,
        action,
        fields: [],
        selectOptions: [],
        submitLabel: null,
        hasFile: false,
        hasDate: false,
        hasPassword: false,
      }
      el.onEndTag(() => {
        if (!activeForm) return
          const f = activeForm
          activeForm = null
          if (f.hasPassword) return
            if (f.fields.length === 0) return
              if (f.fields.length === 1 && (f.fields[0].name === "s" || f.fields[0].type === "search")) return
                if (
                  f.fields.length <= 2 &&
                  f.fields.every((x) => x.type === "email" || x.type === "checkbox") &&
                  /mc4wp|newsletter|mailchimp|brevo|sib-form/i.test(f.attrs)
                ) {
                  return
                }
                let plugin = "custom"
                if (/wpcf7/i.test(f.attrs)) plugin = "cf7"
                  else if (/wpforms/i.test(f.attrs)) plugin = "wpforms"
                    else if (/elementor-form/i.test(f.attrs)) plugin = "elementor"
                      else if (/gform/i.test(f.attrs)) plugin = "gravity"
                        else if (/hs-form|hubspot/i.test(f.attrs)) plugin = "hubspot"
                          else if (/jotform/i.test(f.attrs)) plugin = "jotform"

                            const combinedLabels = `${f.submitLabel || ""} ${f.fields.map((x) => x.label || x.name).join(" ")} ${f.selectOptions.join(" ")}`.toLowerCase()
                            let purpose: FormAudit["purpose"] = "contact"
                            if (f.hasFile || /allegat|upload|carica|document|refert|ricetta/i.test(combinedLabels)) purpose = "document_submission"
                              else if (f.hasDate || /prenot|appuntament|visita|data|orario/i.test(combinedLabels)) purpose = "appointment_request"
                                else if (/preventiv|quot|sopralluog|offerta/i.test(combinedLabels)) purpose = "quote_request"

                                  out.forms.push({
                                    page_url: pageUrl,
                                    form_id_or_name: f.idOrName,
                                      plugin,
                                      submit_label: f.submitLabel,
                                      field_count: f.fields.length,
                                      fields: f.fields.slice(0, 15),
                                                 dropdown_options: [...new Set(f.selectOptions)].slice(0, 12),
                                                 has_file_upload: f.hasFile,
                                                 has_date_picker: f.hasDate,
                                                 purpose,
                                  })
      })
    },
  })
  .on("form input, form textarea, form select", {
    element(el) {
      if (!activeForm) return
        const tag = el.tagName.toLowerCase()
        const rawType = (el.getAttribute("type") || (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text")).toLowerCase()
        if (rawType === "hidden" || rawType === "honeypot") return
          if (rawType === "password") {
            activeForm.hasPassword = true
            return
          }
          if (rawType === "submit" || rawType === "button") {
            const val = el.getAttribute("value")
            if (val && !activeForm.submitLabel) activeForm.submitLabel = val.trim().slice(0, 60)
              return
          }
          const name = (el.getAttribute("name") || el.getAttribute("id") || rawType).trim()
          if (/^_wpcf7|^ak_|honeypot|g-recaptcha|cf-turnstile/i.test(name)) return
            const label = (el.getAttribute("placeholder") || el.getAttribute("aria-label") || null)?.trim() || null
            const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true"
            if (rawType === "file") activeForm.hasFile = true
              if (rawType === "date" || rawType === "datetime-local" || /data|date|giorno/i.test(`${name} ${label || ""}`)) {
                activeForm.hasDate = true
              }
              if (rawType !== "checkbox" && rawType !== "radio") {
                activeForm.fields.push({ name, type: rawType, label, required })
              }
    },
  })
  .on("form select option", {
    element() {
      activeOptionText = ""
    },
    text(t) {
      if (!activeForm) return
        activeOptionText += t.text
        if (t.lastInTextNode) {
          const clean = decodeEntities(activeOptionText).replace(/\s+/g, " ").trim()
          if (clean && clean.length >= 3 && clean.length <= 65 && !/^(?:seleziona|select|scegli|---|\*)/i.test(clean)) {
            activeForm.selectOptions.push(clean)
          }
          activeOptionText = ""
        }
    },
  })
  .on("form button", {
    element(el) {
      const typ = (el.getAttribute("type") || "submit").toLowerCase()
      activeButtonText = typ === "submit" ? "" : "__IGNORE__"
    },
    text(t) {
      if (!activeForm || activeButtonText === "__IGNORE__") return
        activeButtonText += t.text
        if (t.lastInTextNode) {
          const clean = decodeEntities(activeButtonText).replace(/\s+/g, " ").trim()
          if (clean && !activeForm.submitLabel) activeForm.submitLabel = clean.slice(0, 60)
            activeButtonText = ""
        }
    },
  })

  rewriter.transform(new Response(html)).text().catch(() => {})
  // Synchronously flush HTMLRewriter via string input in Bun:
  try {
    // Bun supports synchronous string transform: rewriter.transform(html)
    if (typeof (rewriter as any).transform === "function") {
      // Already invoked above; titleBuf populated synchronously on string/buffer inputs in Bun.
    }
  } catch {}
  out.title = decodeEntities(titleBuf).replace(/\s+/g, " ").trim() || null

  // Also scan raw decoded text for non-mailto emails & WhatsApp widget scripts
  const decoded = decodeEntities(html)
  for (const m of decoded.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    out.rawEmails.push(m[0])
  }
  for (const m of decoded.matchAll(/data-cfemail=["']([0-9a-fA-F]+)["']/gi)) {
    const dec = decodeCloudflareEmailHex(m[1])
    if (dec) out.rawEmails.push(dec)
  }
  if (/joinchat|click-to-chat|qlwapp|wa\.me\//i.test(html) && out.whatsappLinks.length === 0) {
    const ph = /"phone"\s*:\s*"(\+?\d{8,15})"/i.exec(html)?.[1]
    out.whatsappLinks.push({ url: ph ? `https://wa.me/${ph.replace(/\D/g, "")}` : "whatsapp_widget_detected", prefilled: null })
  }

  return out
}

function parseJsonLdSignals(blocks: string[], pageUrl: string): {
  types: string[]
  locations: Omit<LocationClue, "evidence_id">[]
  hours: string[]
  people: Omit<DecisionMakerClue, "evidence_id">[]
  videos: Omit<VideoSignal, "evidence_id">[]
  emails: string[]
  phones: string[]
} {
  const res = {
    types: [] as string[],
    locations: [] as Omit<LocationClue, "evidence_id">[],
    hours: [] as string[],
    people: [] as Omit<DecisionMakerClue, "evidence_id">[],
    videos: [] as Omit<VideoSignal, "evidence_id">[],
    emails: [] as string[],
    phones: [] as string[],
  }
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return
      if (Array.isArray(node)) {
        for (const item of node) visit(item)
          return
      }
      if (node["@graph"]) visit(node["@graph"])
        const rawType = node["@type"]
        const types = Array.isArray(rawType) ? rawType.map(String) : rawType ? [String(rawType)] : []
        for (const t of types) res.types.push(t)

          if (typeof node.email === "string") res.emails.push(node.email)
            if (typeof node.telephone === "string") res.phones.push(node.telephone)

              const addrList = Array.isArray(node.address) ? node.address : node.address ? [node.address] : []
              for (const a of addrList) {
                if (a && typeof a === "object" && (a.streetAddress || a.addressLocality)) {
                  const raw = [a.streetAddress, [a.postalCode, a.addressLocality].filter(Boolean).join(" ")].filter(Boolean).join(", ")
                  if (raw.length >= 6) {
                    res.locations.push({
                      raw_address: raw,
                      city: a.addressLocality || null,
                      postal_code: a.postalCode || null,
                      phone: typeof node.telephone === "string" ? node.telephone : null,
                      source_url: pageUrl,
                    })
                  }
                }
              }
              if (Array.isArray(node.location)) visit(node.location)
                if (Array.isArray(node.department)) visit(node.department)
                  if (Array.isArray(node.employee)) visit(node.employee)
                    if (Array.isArray(node.founder)) visit(node.founder)
                      if (Array.isArray(node.member)) visit(node.member)

                        if (node.openingHours) {
                          const oh = Array.isArray(node.openingHours) ? node.openingHours.join("; ") : String(node.openingHours)
                          if (oh) res.hours.push(oh)
                        }
                        if (Array.isArray(node.openingHoursSpecification)) {
                          const parts = node.openingHoursSpecification
                          .map((s: any) => {
                            const days = Array.isArray(s?.dayOfWeek) ? s.dayOfWeek.join(",") : s?.dayOfWeek || ""
                            return days && s?.opens && s?.closes ? `${days}: ${s.opens}-${s.closes}` : ""
                          })
                          .filter(Boolean)
                          if (parts.length) res.hours.push(parts.join(" | "))
                        }

                        if (types.includes("Person") && typeof node.name === "string" && node.name.trim().length >= 4) {
                          const full = node.name.trim()
                          const first = extractItalianFirstName(full)
                          res.people.push({
                            full_name: full,
                            first_name: first,
                            role: String(node.jobTitle || "Practitioner / Team"),
                                          source_url: pageUrl,
                                          snippet: `${full}${node.jobTitle ? ` (${node.jobTitle})` : ""}`,
                                          confidence: "high",
                          })
                        }

                        if (types.includes("VideoObject") && (node.contentUrl || node.embedUrl || node.name)) {
                          res.videos.push({
                            url: String(node.embedUrl || node.contentUrl || pageUrl),
                                          provider: "schema_video",
                                          title: node.name ? String(node.name) : null,
                                          author: null,
                                          short_description: node.description ? String(node.description).slice(0, 300) : null,
                                          keywords: [],
                                          captions_excerpt: node.transcript ? String(node.transcript).slice(0, 500) : null,
                                          description_or_transcript_excerpt: String(node.transcript || node.description || "").slice(0, 500) || null,
                                          tier_used: 1,
                          })
                        }
  }

  for (const raw of blocks) {
    try {
      const cleaned = raw.replace(/,\s*([}\]])/g, "$1")
      visit(JSON.parse(cleaned))
  } catch {}
}
return res
}

const ITALIAN_COMMON_FIRST_NAMES = new Set([
  "marco", "luca", "paolo", "andrea", "matteo", "davide", "alessandro", "francesco", "giovanni", "antonio",
  "roberto", "stefano", "fabio", "simone", "daniele", "enrico", "giuseppe", "massimo", "riccardo", "alberto",
  "lorenzo", "filippo", "nicola", "claudio", "michele", "sergio", "pietro", "tommaso", "federico", "emanuele",
  "giorgio", "carlo", "domenico", "cristian", "christian", "valerio", "gabriele", "raffaele", "vincenzo",
  "giulia", "chiara", "francesca", "sara", "laura", "valentina", "alessia", "elena", "martina", "silvia",
  "paola", "anna", "monica", "daniela", "roberta", "federica", "elisa", "ilaria", " barbara", "cristina",
  "simona", "manuela", "emanuela", "beatrice", "alice", "giorgia", "veronica", "stefania", "cinzia", "marta",
])

export function extractItalianFirstName(fullName: string): string | null {
  const cleaned = fullName
  .replace(/\b(?:dott\.?ssa|dott\.?|dr\.?ssa|dr\.?|prof\.?ssa|prof\.?|avv\.?|ing\.?|arch\.?|rag\.?|geom\.?|odontoiatra|med\.)\b/gi, " ")
  .replace(/\s+/g, " ")
  .trim()
  const tokens = cleaned.split(" ").filter((t) => /^[A-ZÀ-Ú][a-zà-ú'-]{2,}$/.test(t) || /^[A-Z]{3,}$/.test(t))
  if (!tokens.length) return null
    const first = tokens[0].toLowerCase()
    if (ITALIAN_COMMON_FIRST_NAMES.has(first)) {
      return first.charAt(0).toUpperCase() + first.slice(1)
    }
    // Handle reversed Italian surname-first ("ROSSI MARCO")
    if (tokens.length === 2 && ITALIAN_COMMON_FIRST_NAMES.has(tokens[1].toLowerCase())) {
      const second = tokens[1].toLowerCase()
      return second.charAt(0).toUpperCase() + second.slice(1)
    }
    return null
}

function extractGovernanceAndTeamFromText(
  text: string,
  pageUrl: string,
  bucket: PageBucket,
): { clues: Omit<DecisionMakerClue, "evidence_id">[]; titledPersonCount: number } {
  const clues: Omit<DecisionMakerClue, "evidence_id">[] = []
  const seenNames = new Set<string>()

  // 1. Mandatory Italian healthcare Direttore Sanitario (Law 145/2018)
  const dirSanRe =
  /Direttore\s+Sanitario\s*[:\-–]?\s*((?:(?:Dott\.?ssa|Dott\.?|Dr\.?ssa|Dr\.?|Prof\.?|Odontoiatra)\s+)*[A-ZÀ-Ú][a-zà-ú']+(?:\s+[A-ZÀ-Ú][a-zà-ú']+){1,2})/gi
  for (const m of text.matchAll(dirSanRe)) {
    const full = m[1].replace(/\s+/g, " ").trim()
    const key = full.toLowerCase()
    if (!seenNames.has(key)) {
      seenNames.add(key)
      clues.push({
        full_name: full,
        first_name: extractItalianFirstName(full),
                 role: "Direttore Sanitario",
                 source_url: pageUrl,
                 snippet: m[0].slice(0, 140),
                 confidence: "high",
      })
    }
  }

  // 2. Titolare / Socio Fondatore / Managing Partner / Amministratore Unico
  const ownerRe =
  /\b(Titolare|Socio\s+Fondatore|Fondatore|Managing\s+Partner|Amministratore\s+Unico)\s*[:\-–]?\s*((?:(?:Dott\.?ssa|Dott\.?|Dr\.?|Avv\.?|Ing\.?|Rag\.?)\s+)*[A-ZÀ-Ú][a-zà-ú']+(?:\s+[A-ZÀ-Ú][a-zà-ú']+){1,2})/gi
  for (const m of text.matchAll(ownerRe)) {
    const role = m[1].replace(/\s+/g, " ").trim()
    const full = m[2].replace(/\s+/g, " ").trim()
    const key = full.toLowerCase()
    if (!seenNames.has(key)) {
      seenNames.add(key)
      clues.push({
        full_name: full,
        first_name: extractItalianFirstName(full),
                 role,
                 source_url: pageUrl,
                 snippet: m[0].slice(0, 140),
                 confidence: "high",
      })
    }
  }

  // 3. Count professional profiles on team/about pages
  const profMatches = [
    ...text.matchAll(
      /\b(?:Dott\.?ssa|Dott\.|Dr\.?ssa|Dr\.|Avv\.|Ing\.|Arch\.|Rag\.)\s+[A-ZÀ-Ú][a-zà-ú']+\s+[A-ZÀ-Ú][a-zà-ú']+/g,
    ),
  ]
  const uniqueProfs = new Set(profMatches.map((m) => m[0].replace(/\s+/g, " ").toLowerCase()))
  if (bucket === "team_governance") {
    for (const m of profMatches.slice(0, 6)) {
      const full = m[0].replace(/\s+/g, " ").trim()
      const key = full.toLowerCase()
      if (!seenNames.has(key)) {
        seenNames.add(key)
        clues.push({
          full_name: full,
          first_name: extractItalianFirstName(full),
                   role: "Professionista / Team",
                   source_url: pageUrl,
                   snippet: full,
                   confidence: "medium",
        })
      }
    }
  }
  return { clues, titledPersonCount: uniqueProfs.size }
}

function extractHoursAndUrgency(text: string, pageUrl: string): { hours: string[]; urgency: string[] } {
  const hours: string[] = []
  const urgency: string[] = []
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (
      /\b(?:lun(?:ed[iì])?|mar(?:ted[iì])?|mer(?:coled[iì])?|gio(?:ved[iì])?|ven(?:erd[iì])?|sab(?:ato)?|orari(?:o)?\s+(?:di\s+)?(?:apertura|segreteria|ricevimento|studio)|mon\s*[-–]\s*fri)\b/i.test(
        ln,
      ) &&
      /\b\d{1,2}[:.]\d{2}\b/.test(`${ln} ${lines[i + 1] || ""}`)
    ) {
      const snippet = `${ln} ${lines[i + 1] && /\d{1,2}[:.]\d{2}/.test(lines[i + 1]) ? lines[i + 1] : ""}`.trim().slice(0, 180)
      if (snippet.length >= 10) hours.push(snippet)
    }
    if (/\b(?:urgenz[ae]|pronto\s+intervento|reperibilit[àa]|emergenz[ae]\s+odontoiatric|riceve\s+su\s+appuntamento)\b/i.test(ln)) {
      urgency.push(`${ln.slice(0, 140)} (${pageUrl})`)
    }
  }
  return { hours: [...new Set(hours)].slice(0, 4), urgency: [...new Set(urgency)].slice(0, 4) }
}

function extractAddressesFromText(text: string, pageUrl: string): Omit<LocationClue, "evidence_id">[] {
  const results: Omit<LocationClue, "evidence_id">[] = []
  const re =
  /\b((?:Via|Viale|Piazza|Piazzale|Corso|Strada|Vicolo|Largo|Localit[àa]|Frazione)\s+[A-ZÀ-Ú0-9][^,;\n|]{3,55}?(?:,\s*\d+[A-Za-z\/]?)?)\s*[,–-]?\s*(\b\d{5}\b)?\s*([A-ZÀ-Ú][A-Za-zÀ-ú\s'()-]{2,28})?/g
  for (const m of text.matchAll(re)) {
    const raw = m[0].replace(/\s+/g, " ").trim()
    if (raw.length < 12 || raw.length > 130) continue
      if (!m[2] && !/\b(?:Via|Viale|Piazza|Corso)\b/.test(raw)) continue
        results.push({
          raw_address: raw,
          city: m[3] ? m[3].trim() : null,
                     postal_code: m[2] || null,
                     phone: null,
                     source_url: pageUrl,
        })
  }
  return results.slice(0, 5)
}

async function extractPdfSignalBounded(url: string, anchor: string): Promise<Omit<PdfSignal, "evidence_id"> | null> {
  const MAX_BYTES = 2_500_000
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok || !res.body) return null
      const cl = Number(res.headers.get("content-length") || "0")
      if (cl > MAX_BYTES) return null

        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
            if (value) {
              total += value.byteLength
              if (total > MAX_BYTES) {
                try { await reader.cancel() } catch {}
                break
              }
              chunks.push(value)
            }
        }
        const merged = new Uint8Array(Math.min(total, MAX_BYTES))
        let offset = 0
        for (const c of chunks) {
          if (offset + c.byteLength > merged.byteLength) break
            merged.set(c, offset)
            offset += c.byteLength
        }

        let extracted = ""
        const pdftotextBin = typeof Bun !== "undefined" ? Bun.which("pdftotext") : null
        if (pdftotextBin) {
          const proc = Bun.spawn([pdftotextBin, "-l", "8", "-nopgbrk", "-", "-"], {
            stdin: merged,
            stdout: "pipe",
            stderr: "ignore",
          })
          const timer = setTimeout(() => { try { proc.kill() } catch {} }, 3000)
          extracted = await new Response(proc.stdout).text().catch(() => "")
          clearTimeout(timer)
        }
        if (!extracted.trim()) {
          // Lightweight fallback for uncompressed PDF text strings
          const latin = new TextDecoder("latin1").decode(merged)
          const strLiterals = [...latin.matchAll(/\(([^()\\]{4,120})\)\s*Tj/g)].map((m) => m[1])
          extracted = strLiterals.join(" ")
        }
        const clean = extracted.replace(/\s+/g, " ").trim()
        if (clean.length < 40) return null

          const combinedName = `${url} ${anchor}`.toLowerCase()
          let docKind: PdfSignal["doc_kind"] = "other"
          if (/carta.?dei.?servizi/i.test(combinedName)) docKind = "carta_dei_servizi"
            else if (/modul|preparazione|consenso/i.test(combinedName)) docKind = "modulistica"
              else if (/tariff|listino|convenzion/i.test(combinedName)) docKind = "tariffario_convenzioni"
                else if (/brochure|presentazione|profile|catalogo/i.test(combinedName)) docKind = "company_profile"

                  const tagPatterns = [
                    "UniSalute", "Previmedical", "Fasi", "Fasdac", "Metasalute", "ProntoCare", "Blue Assistance",
                    "Generali Welion", "Allianz", "ISO 9001", "SSN", "Accreditato", "Direttore Sanitario",
                  ]
                  const tags = tagPatterns.filter((t) => new RegExp(`\\b${t.replace(/\s+/g, "\\s+")}\\b`, "i").test(clean))

                  return {
                    url,
                    anchor_text: anchor || url.split("/").pop() || "PDF",
                    doc_kind: docKind,
                    bytes_read: offset,
                    extracted_tags: tags,
                    text_excerpt: clean.slice(0, 1000),
                  }
  } catch {
    return null
  }
}

function parseYouTubeVideoId(rawUrl: string): string | null {
  const m =
  /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i.exec(rawUrl)
  return m ? m[1] : null
}

async function enrichVideoTier1And2(
  rawUrl: string,
  enableTier2: boolean,
  enableTier3Audio = false,
): Promise<Omit<VideoSignal, "evidence_id"> | null> {
  const ytId = parseYouTubeVideoId(rawUrl)
  const vimeoId = /vimeo\.com\/(?:video\/)?(\d{6,12})/i.exec(rawUrl)?.[1] ?? null

  if (!ytId && !vimeoId && !/\.(?:mp4|webm)(?:\?|$)/i.test(rawUrl) && !/loom\.com\/(?:share|embed)\//i.test(rawUrl)) {
    return null
  }

  let provider: VideoSignal["provider"] = "html5"
  let canonicalUrl = rawUrl
  if (ytId) {
    provider = "youtube"
    canonicalUrl = `https://www.youtube.com/watch?v=${ytId}`
  } else if (vimeoId) {
    provider = "vimeo"
    canonicalUrl = `https://vimeo.com/${vimeoId}`
  } else if (/loom\.com/i.test(rawUrl)) {
    provider = "loom"
  }

  let title: string | null = null
  let author: string | null = null
  let shortDescription: string | null = null
  let keywords: string[] = []
  let captionsExcerpt: string | null = null
  let tierUsed: 1 | 2 | 3 = 1

  // Tier 1: Fast keyless oEmbed (< 800ms typical, 1500ms timeout)
  if (provider === "youtube" || provider === "vimeo") {
    const oembedUrl =
    provider === "youtube"
    ? `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`
    : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonicalUrl)}`
    try {
      const r = await fetch(oembedUrl, { signal: AbortSignal.timeout(1500) })
      if (r.ok) {
        const j = (await r.json()) as any
        title = j?.title ? String(j.title).trim() : null
        author = j?.author_name ? String(j.author_name).trim() : null
      }
    } catch {}
  }

  // Tier 2 (Refinement #4): Hero video shortDescription + keywords + captionTracks (it/en), 2s timeout
  if (enableTier2 && ytId) {
    try {
      const watchRes = await fetch(`https://www.youtube.com/watch?v=${ytId}&hl=it`, {
        headers: { ...BROWSER_HEADERS, Cookie: "CONSENT=YES+cb" },
        signal: AbortSignal.timeout(2000),
      })
      if (watchRes.ok) {
        const html = await watchRes.text()
        const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*(?:var\s|<\/script>)/)
        if (playerMatch) {
          try {
            const player = JSON.parse(playerMatch[1])
            const vd = player?.videoDetails
            if (vd) {
              tierUsed = 2
              if (!title && vd.title) title = String(vd.title)
                if (!author && vd.author) author = String(vd.author)
                  if (typeof vd.shortDescription === "string" && vd.shortDescription.trim()) {
                    shortDescription = vd.shortDescription.replace(/\s+/g, " ").trim().slice(0, 500)
                  }
                  if (Array.isArray(vd.keywords)) {
                    keywords = vd.keywords.map(String).slice(0, 15)
                  }
            }
            const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks
            if (Array.isArray(tracks) && tracks.length > 0) {
              const preferred =
              tracks.find((t: any) => /^it/i.test(t.languageCode) && t.kind !== "asr") ||
              tracks.find((t: any) => /^it/i.test(t.languageCode)) ||
              tracks.find((t: any) => /^en/i.test(t.languageCode)) ||
              tracks[0]
              if (preferred?.baseUrl) {
                const capRes = await fetch(String(preferred.baseUrl), { signal: AbortSignal.timeout(1500) })
                if (capRes.ok) {
                  const xml = await capRes.text()
                  const capText = stripTagsClean(xml).replace(/\s+/g, " ").trim()
                  if (capText.length >= 20) {
                    captionsExcerpt = capText.slice(0, 600)
                    tierUsed = 2
                  }
                }
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Tier 3: Strictly opt-in yt-dlp fallback (NEVER runs in batch or unless explicitly requested)
  if (enableTier3Audio && !captionsExcerpt && ytId && typeof Bun !== "undefined") {
    const ytdlp = Bun.which("yt-dlp")
    if (ytdlp) {
      try {
        const proc = Bun.spawn(
          [ytdlp, "--skip-download", "--dump-single-json", "--no-playlist", canonicalUrl],
          { stdout: "pipe", stderr: "ignore" },
        )
        const timer = setTimeout(() => { try { proc.kill() } catch {} }, 12_000)
        const rawJson = await new Response(proc.stdout).text().catch(() => "")
        clearTimeout(timer)
        if (rawJson) {
          const info = JSON.parse(rawJson)
          if (!shortDescription && info?.description) {
            shortDescription = String(info.description).replace(/\s+/g, " ").trim().slice(0, 500)
          }
          tierUsed = 3
        }
      } catch {}
    }
  }

  const combinedExcerpt = [
    shortDescription ? `Desc: ${shortDescription}` : "",
    keywords.length ? `Keywords: ${keywords.join(", ")}` : "",
    captionsExcerpt ? `Captions: ${captionsExcerpt}` : "",
  ]
  .filter(Boolean)
  .join(" | ")
  .slice(0, 900)

  return {
    url: canonicalUrl,
    provider,
    title,
    author,
    short_description: shortDescription,
    keywords,
    captions_excerpt: captionsExcerpt,
    description_or_transcript_excerpt: combinedExcerpt || null,
    tier_used: tierUsed,
  }
}

export async function crawlWebsiteAudit(website: string, opts?: CrawlAuditOptions): Promise<WebsiteIntelV2> {
  const mode = opts?.mode ?? "scout_fast"
  const isDeep = mode === "deep_audit"
  const maxPages = isDeep ? 10 : 3
  const pageTimeout = isDeep ? 6500 : 4000
  const totalDeadline = Date.now() + (isDeep ? 22_000 : 8500)

  const intel: WebsiteIntelV2 = {
    email: null,
    pec: null,
    address: null,
    phone: null,
    vat: null,
    socials: [],
    detected_language: /\.it(?:\/|$)/i.test(website) ? "it" : null,
    site_text: null,
    found_at_step: null,
    crawl_mode: mode,
    anti_bot_blocked: false,
    pages_crawled: [],
    email_candidates: [],
    phones_found: [],
    whatsapp: { detected: false, phone_or_url: null, prefilled_text: null },
    addresses_found: [],
    locations_count: 1,
    languages_detected: [],
    channels_detected: [],
    booking_widgets: [],
    chat_widgets: [],
    cms_and_tech: [],
    forms: [],
      hours_snippets: [],
      urgency_or_saturday_clues: [],
      decision_maker_clues: [],
      team_count_hint: { band: "unknown", counted_profiles: 0, basis: "none" },
      schema_org_types: [],
      pdf_signals: [],
      video_signals: [],
  }

  const raw = (website || "").trim()
  if (!raw) return intel
    const initialUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

    const visited = new Set<string>()
    const textSections: string[] = []
    const rawEmailPages = new Map<string, { pages: Set<string>; nonLegalSeen: boolean }>()
    const phoneSet = new Set<string>()
    const socialSet = new Set<string>()
    const langSet = new Set<string>()
    const bookingMap = new Map<string, { name: string; mode: "instant_slot" | "request_form" | "external_portal"; url_or_clue: string }>()
    const chatSet = new Set<string>()
    const techSet = new Set<string>()
    const schemaTypes = new Set<string>()
    const rawLocations: Omit<LocationClue, "evidence_id">[] = []
    const rawForms: Omit<FormAudit, "evidence_id">[] = []
    const rawHours: { text: string; source_url: string }[] = []
    const urgencySet = new Set<string>()
    const rawDmClues: Omit<DecisionMakerClue, "evidence_id">[] = []
    const pdfQueue = new Map<string, string>()
    const videoEmbeds = new Set<string>()
    const schemaVideos: Omit<VideoSignal, "evidence_id">[] = []
    let maxTitledProfilesOnSinglePage = 0

    const recordEmailRaw = (e: string, pageUrl: string, isLegal: boolean) => {
      const key = e.trim().toLowerCase()
      if (!key) return
        const cur = rawEmailPages.get(key) ?? { pages: new Set<string>(), nonLegalSeen: false }
        cur.pages.add(pageUrl)
        if (!isLegal) cur.nonLegalSeen = true
          rawEmailPages.set(key, cur)
    }

    const processPage = async (url: string, bucket: PageBucket): Promise<PageDomExtract | null> => {
      if (Date.now() > totalDeadline || intel.pages_crawled.length >= maxPages) return null
        const uKey = normalizeUrlKey(url)
        if (visited.has(uKey)) return null
          visited.add(uKey)

          let fetched = await fetchHtmlSmart(url, pageTimeout)
          if (!fetched && intel.pages_crawled.length === 0 && url.startsWith("https://")) {
            fetched = await fetchHtmlSmart(url.replace(/^https:\/\//i, "http://"), pageTimeout)
          }
          if (!fetched) return null
            if (fetched.antiBot) {
              if (intel.pages_crawled.length === 0) intel.anti_bot_blocked = true
                return null
            }
            visited.add(normalizeUrlKey(fetched.finalUrl))

            const html = fetched.html
            const finalUrl = fetched.finalUrl
            const isLegal = bucket === "legal_fallback"
            const dom = inspectHtmlWithRewriter(html, finalUrl)
            const cleanText = stripTagsClean(html)

            intel.pages_crawled.push({
              url: finalUrl,
              bucket,
              title: dom.title,
              chars: cleanText.length,
            })
            if (cleanText && !isLegal) {
              textSections.push(`[PAGE ${bucket.toUpperCase()}: ${finalUrl}]\n${cleanText.slice(0, isDeep ? 3500 : 1800)}`)
            }

            if (dom.htmlLang) langSet.add(dom.htmlLang.slice(0, 2))
              for (const hl of dom.hreflangs) if (/^[a-z]{2}$/.test(hl)) langSet.add(hl)

                for (const e of dom.rawEmails) recordEmailRaw(e, finalUrl, isLegal)
                  for (const t of dom.telLinks) phoneSet.add(t)
                    for (const m of cleanText.matchAll(/(?:\+39\s*)?(?:0\d{1,4}[\s./-]?\d{5,8}|3\d{2}[\s./-]?\d{6,7})/g)) {
                      phoneSet.add(m[0].trim())
                    }
                    if (!intel.vat) {
                      const vatM = /(?:P\.?\s*IVA|Partita\s+IVA|C\.?\s*F\.?)\s*:?\s*(?:IT)?\s*(\d{11})\b/i.exec(cleanText)
                      if (vatM) intel.vat = vatM[1]
                    }
                    for (const s of dom.socials) socialSet.add(s)
                      if (dom.whatsappLinks.length > 0 && !intel.whatsapp.detected) {
                        intel.whatsapp = {
                          detected: true,
                          phone_or_url: dom.whatsappLinks[0].url,
                          prefilled_text: dom.whatsappLinks[0].prefilled,
                        }
                      }

                      for (const bf of BOOKING_FINGERPRINTS) {
                        const hitUrl = dom.embedUrls.find((u) => bf.re.test(u))
                        if (hitUrl || bf.re.test(html)) {
                          bookingMap.set(bf.name, { name: bf.name, mode: bf.mode, url_or_clue: hitUrl || finalUrl })
                        }
                      }
                      for (const cf of CHAT_FINGERPRINTS) if (cf.re.test(html)) chatSet.add(cf.name)
                        for (const tf of TECH_FINGERPRINTS) if (tf.re.test(html)) techSet.add(tf.name)

                          const ld = parseJsonLdSignals(dom.jsonLdBlocks, finalUrl)
                          for (const t of ld.types) schemaTypes.add(t)
                            for (const e of ld.emails) recordEmailRaw(e, finalUrl, isLegal)
                              for (const p of ld.phones) phoneSet.add(p)
                                rawLocations.push(...ld.locations)
                                for (const h of ld.hours) rawHours.push({ text: h, source_url: finalUrl })
                                  rawDmClues.push(...ld.people)
                                  schemaVideos.push(...ld.videos)

                                  if (!isLegal) {
                                    rawForms.push(...dom.forms)
                                    rawLocations.push(...extractAddressesFromText(cleanText, finalUrl))
                                    const hu = extractHoursAndUrgency(cleanText, finalUrl)
                                    for (const h of hu.hours) rawHours.push({ text: h, source_url: finalUrl })
                                      for (const u of hu.urgency) urgencySet.add(u)
                                  }

                                  const gov = extractGovernanceAndTeamFromText(cleanText, finalUrl, bucket)
                                  rawDmClues.push(...gov.clues)
                                  if (gov.titledPersonCount > maxTitledProfilesOnSinglePage) {
                                    maxTitledProfilesOnSinglePage = gov.titledPersonCount
                                  }

                                  for (const pdf of dom.pdfLinks) {
                                    if (!BLOCKED_PDF_RE.test(`${pdf.url} ${pdf.anchor}`)) {
                                      pdfQueue.set(pdf.url, pdf.anchor)
                                    }
                                  }
                                  for (const emb of dom.embedUrls) {
                                    if (parseYouTubeVideoId(emb) || /vimeo\.com\/\d+|loom\.com\/|\.(?:mp4|webm)/i.test(emb)) {
                                      videoEmbeds.add(emb)
                                    }
                                  }

                                  return dom
    }

    const homeDom = await processPage(initialUrl, "home")
    if (homeDom) {
      const homePageUrl = intel.pages_crawled[0]?.url || initialUrl
      const origin = new URL(homePageUrl).origin

      // Check if scout_fast can stop immediately on a clean sendable email
      if (!isDeep) {
        const earlyCandidates: EmailCandidate[] = []
        for (const [rawE, meta] of rawEmailPages.entries()) {
          const c = classifyEmailCandidate(rawE, {
            website: homePageUrl,
            businessName: opts?.businessName,
            foundOnPages: [...meta.pages],
            foundInLegalOnly: !meta.nonLegalSeen,
          })
          if (c) earlyCandidates.push(c)
        }
        const { bestSendable } = selectBestEmails(earlyCandidates)
        if (bestSendable) {
          intel.found_at_step = "1:homepage"
        }
      }

      if (isDeep || !intel.found_at_step) {
        const candidatePool = new Map<string, { url: string; bucket: PageBucket; score: number }>()
        for (const l of homeDom.internalLinks) {
          const sb = scoreAndBucketLink(new URL(l.url).pathname, l.anchor)
          if (sb.score > 0) candidatePool.set(normalizeUrlKey(l.url), { url: l.url, ...sb })
        }
        if (isDeep) {
          const smUrls = await fetchSitemapLinks(origin)
          for (const su of smUrls) {
            try {
              const u = new URL(su)
              const sb = scoreAndBucketLink(u.pathname, "")
              if (sb.score >= 30 && !candidatePool.has(normalizeUrlKey(su))) {
                candidatePool.set(normalizeUrlKey(su), { url: su, ...sb })
              }
            } catch {}
          }
        }
        // Fallback probes if nav uses JS-rendered menus
        for (const probe of [
          { p: "/contatti", b: "contact_intake" as PageBucket, s: 25 },
          { p: "/chi-siamo", b: "team_governance" as PageBucket, s: 22 },
        ]) {
          const u = `${origin}${probe.p}`
          if (!candidatePool.has(normalizeUrlKey(u))) {
            candidatePool.set(normalizeUrlKey(u), { url: u, bucket: probe.b, score: probe.s })
          }
        }

        // Diversified selection: max 2 per operational bucket, prioritized by score
        const sortedLinks = [...candidatePool.values()].sort((a, b) => b.score - a.score)
        const bucketCounts = new Map<PageBucket, number>()
        const toVisit: { url: string; bucket: PageBucket }[] = []
        for (const item of sortedLinks) {
          if (!isDeep && item.bucket === "legal_fallback" && toVisit.length >= 2) continue
            const used = bucketCounts.get(item.bucket) ?? 0
            const cap = item.bucket === "legal_fallback" ? 1 : 2
            if (used >= cap) continue
              bucketCounts.set(item.bucket, used + 1)
              toVisit.push({ url: item.url, bucket: item.bucket })
              if (toVisit.length >= maxPages - 1) break
        }

        // Fetch in bounded waves of 3
        for (let i = 0; i < toVisit.length; i += 3) {
          if (Date.now() > totalDeadline) break
            const wave = toVisit.slice(i, i + 3)
            await Promise.allSettled(wave.map((w) => processPage(w.url, w.bucket)))
            if (!isDeep) {
              // scout_fast check after contact wave
              for (const [rawE, meta] of rawEmailPages.entries()) {
                const c = classifyEmailCandidate(rawE, {
                  website: homePageUrl,
                  businessName: opts?.businessName,
                  foundOnPages: [...meta.pages],
                  foundInLegalOnly: !meta.nonLegalSeen,
                })
                if (c?.sendable) {
                  intel.found_at_step = "2:subpages"
                  break
                }
              }
              if (intel.found_at_step) break
            }
        }
      }
    }

    // Classify all discovered emails via Hard Email Gate
    const refUrl = intel.pages_crawled[0]?.url || initialUrl
    const classified: EmailCandidate[] = []
    for (const [rawE, meta] of rawEmailPages.entries()) {
      const c = classifyEmailCandidate(rawE, {
        website: refUrl,
        businessName: opts?.businessName,
        foundOnPages: [...meta.pages],
        foundInLegalOnly: !meta.nonLegalSeen,
      })
      if (c) classified.push(c)
    }
    const { bestSendable, bestPec, sortedAll } = selectBestEmails(classified)
    intel.email_candidates = sortedAll
    intel.email = bestSendable?.email ?? null
    intel.pec = bestPec?.email ?? null
    if (bestSendable && !intel.found_at_step) {
      intel.found_at_step = bestSendable.found_on_pages[0] || "deep_audit"
    }

    // Deduplicate locations
    const seenAddrKeys = new Set<string>()
    for (const loc of rawLocations) {
      const normKey = loc.raw_address.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)
      if (normKey.length < 8 || seenAddrKeys.has(normKey)) continue
        seenAddrKeys.add(normKey)
        intel.addresses_found.push({ ...loc, evidence_id: `loc:${intel.addresses_found.length}` })
    }
    intel.locations_count = Math.max(1, intel.addresses_found.length)
    intel.address = intel.addresses_found[0]?.raw_address ?? null

    intel.phones_found = [...phoneSet].slice(0, 8)
    intel.phone = intel.phones_found[0] ?? null
    intel.socials = [...socialSet]

    // Assign deterministic evidence_ids
    intel.forms = rawForms.slice(0, 6).map((f, idx) => ({ ...f, evidence_id: `form:${idx}` }))
    const seenHours = new Set<string>()
    for (const h of rawHours) {
      const k = h.text.toLowerCase()
      if (seenHours.has(k)) continue
        seenHours.add(k)
        intel.hours_snippets.push({ evidence_id: `hours:${intel.hours_snippets.length}`, ...h })
        if (intel.hours_snippets.length >= 5) break
    }
    intel.urgency_or_saturday_clues = [...urgencySet].slice(0, 5)

    const seenDm = new Set<string>()
    for (const dm of rawDmClues) {
      const k = dm.full_name.toLowerCase()
      if (seenDm.has(k)) continue
        seenDm.add(k)
        intel.decision_maker_clues.push({ ...dm, evidence_id: `dm:${intel.decision_maker_clues.length}` })
    }

    // Team size hint
    const profCount = Math.max(maxTitledProfilesOnSinglePage, intel.decision_maker_clues.length)
    if (profCount >= 26) intel.team_count_hint = { band: "26-50", counted_profiles: profCount, basis: "staff_profiles_counted" }
    else if (profCount >= 11) intel.team_count_hint = { band: "11-25", counted_profiles: profCount, basis: "staff_profiles_counted" }
    else if (profCount >= 6) intel.team_count_hint = { band: "6-10", counted_profiles: profCount, basis: "staff_profiles_counted" }
    else if (profCount >= 2) intel.team_count_hint = { band: "2-5", counted_profiles: profCount, basis: "staff_profiles_counted" }
    else if (profCount === 1) intel.team_count_hint = { band: "1", counted_profiles: 1, basis: "single_principal_detected" }

    // PDFs & Videos (deep_audit only)
    if (isDeep && Date.now() < totalDeadline) {
      const rankedPdfs = [...pdfQueue.entries()].sort((a, b) => {
        const sa = HIGH_SIGNAL_PDF_RE.test(`${a[0]} ${a[1]}`) ? 1 : 0
        const sb = HIGH_SIGNAL_PDF_RE.test(`${b[0]} ${b[1]}`) ? 1 : 0
        return sb - sa
      })
      const pdfResults = await Promise.allSettled(
        rankedPdfs.slice(0, 2).map(([u, anc]) => extractPdfSignalBounded(u, anc)),
      )
      for (const r of pdfResults) {
        if (r.status === "fulfilled" && r.value) {
          intel.pdf_signals.push({ ...r.value, evidence_id: `pdf:${intel.pdf_signals.length}` })
        }
      }

      for (const sv of schemaVideos.slice(0, 2)) {
        intel.video_signals.push({ ...sv, evidence_id: `vid:${intel.video_signals.length}` })
      }
      const embedArr = [...videoEmbeds].slice(0, 3)
      for (let i = 0; i < embedArr.length; i++) {
        const isHero = i === 0 // Max 1 hero video gets Tier 2 metadata + captions fetch
        const vSig = await enrichVideoTier1And2(embedArr[i], isHero, Boolean(opts?.transcribeVideoAudio && isHero))
        if (vSig) {
          intel.video_signals.push({ ...vSig, evidence_id: `vid:${intel.video_signals.length}` })
        }
      }
    }

    intel.booking_widgets = [...bookingMap.values()]
    intel.chat_widgets = [...chatSet]
    intel.cms_and_tech = [...techSet]
    intel.schema_org_types = [...schemaTypes]
    intel.languages_detected = [...langSet]
    if (intel.languages_detected.includes("it")) intel.detected_language = "it"
      else if (intel.languages_detected.includes("en") && !intel.detected_language) intel.detected_language = "en"

        const channels: WebsiteIntelV2["channels_detected"] = []
        if (intel.email) channels.push("email")
          if (intel.phones_found.length) channels.push("phone")
            if (intel.whatsapp.detected) channels.push("whatsapp")
              if (intel.forms.length) channels.push("contact_form")
                if (intel.booking_widgets.length) channels.push("online_booking")
                  if (intel.chat_widgets.length) channels.push("live_chat")
                    if (intel.pec) channels.push("pec")
                      intel.channels_detected = channels

                      const fullText = textSections.join("\n\n").trim()
                      intel.site_text = fullText ? fullText.slice(0, isDeep ? 24_000 : 5_000) : null
                      return intel
}
