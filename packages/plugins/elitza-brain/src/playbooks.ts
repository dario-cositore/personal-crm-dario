/**
 * Elitza Brain — modular playbook knowledge base.
 *
 * Editable JSON playbooks live in ~/.ai-enablement-agent/playbooks/*.json so
 * copy, scripts and red lines can be edited on disk without touching TS.
 */

import fs from "node:fs"
import path from "node:path"
import { AI_ENABLEMENT_HOME } from "./db.js"
import { getClient } from "./crm.js"
import { routeClientTrack } from "./routing.js"

export interface StagePlaybook {
  what_to_do: string[]
  what_to_say: { channel: "email" | "call" | "whatsapp"; subject?: string; script: string }[]
  what_not_to_say: string[]
  objection_handlers: { objection: string; reply: string }[]
  auto_bundle: { templates: string[]; worksheets: string[]; triggers: { event: string; name: string; subject: string; body: string; cooldown_days?: number }[] }
}

export interface CasePlaybook {
  id: string
  title?: string
  match: { languages: string[]; tracks: string[]; verticals: string[]; pain_categories: string[] }
  pricing: { track_name: string; currency: string; setup_price: string; recurring_price: string; credit_rule?: string }
  stages: Record<string, StagePlaybook>
}

export function playbooksDir(): string {
  return path.join((process.env.AI_ENABLEMENT_HOME ?? process.env.ELITZA_HOME) ?? AI_ENABLEMENT_HOME, "playbooks")
}

function ensureDir(): void { fs.mkdirSync(playbooksDir(), { recursive: true }) }

export function listPlaybooks(): string[] {
  ensureDir()
  return fs.readdirSync(playbooksDir()).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()
}

export function loadPlaybook(id: string): CasePlaybook | null {
  const f = path.join(playbooksDir(), `${id}.json`)
  if (!fs.existsSync(f)) return null
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as CasePlaybook } catch { return null }
}

export function savePlaybook(pb: CasePlaybook): void {
  ensureDir()
  fs.writeFileSync(path.join(playbooksDir(), `${pb.id}.json`), JSON.stringify(pb, null, 2), { mode: 0o644 })
}

const CURATED_PLAYBOOKS: CasePlaybook[] = [
{
  "id": "en-entry-diagnostic",
  "title": "EN Entry — Discovery Call & Architecture & Readiness Review",
  "match": {
    "languages": [
      "en"
    ],
    "tracks": [
      "entry"
    ],
    "verticals": [
      "*"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Entry — Architecture & Readiness Review",
    "currency": "USD",
    "setup_price": "$0 Discovery Call / $1,500 Architecture & Readiness Review",
    "recurring_price": "$0",
    "credit_rule": "100% of the $1,500 Architecture & Readiness Review fee is credited toward Track 1 (Owned Workflows) or Track 2 (Mach 1 Tower) if started within 30 days."
  },
  "stages": {
    "scouted": {
      "what_to_do": [
        "Run enrich_client to extract tech stack, team size, and operational bottlenecks.",
        "Verify a real decision-maker email (founder, COO, managing partner, head of ops).",
        "Confirm language is English and currency is strictly USD."
      ],
      "what_to_say": [],
      "what_not_to_say": [
        "Never mention EUR prices or use the Euro symbol anywhere in English outreach.",
        "Do not send outreach before enrichment confirms an actual operational bottleneck."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Pick one concrete operational leak from the enrichment report (lead response lag, manual intake, fragmented CRM/inbox).",
        "Review the auto-generated Touch 1 draft in pipeline/ and replace any generic phrase with a specific observation from their site.",
        "Approve and send Touch 1 via Resend."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Quick note on {{CLIENT_NAME}}'s {{PAIN_CATEGORY}}",
          "script": "Hi {{CLIENT_NAME}},\n\nI took a look at how your team handles {{PAIN_CATEGORY}} inside a {{VERTICAL}} workflow — that is the exact operational bottleneck I fix.\n\nBefore proposing any build, I run a fixed-scope Architecture & Readiness Review ($1,500, 100% credited if we build) so you get a concrete blueprint, exact system boundaries, and upfront pricing with zero vendor lock-in.\n\nWorth a 20-minute Discovery Call ($0) this week to see if it fits? Either way I will send you a concrete first approach you can use internally.\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Never pitch open-ended 'AI transformation' or vague multi-month pilots.",
        "Never use inline EUR pricing.",
        "Do not attach generic PDFs or prompt packs on cold outreach."
      ],
      "objection_handlers": [
        {
          "objection": "We already use ChatGPT / Copilot internally.",
          "reply": "Ad-hoc chat tools help individuals write faster, but they do not move data between your inbox, CRM, and billing without human copy-pasting. We wire deterministic pipelines or governed agents directly into your operations with full handover."
        },
        {
          "objection": "Why pay $1,500 for a review before building?",
          "reply": "It prevents buying the wrong architecture. You walk away with a complete technical spec and ROI map you can implement with anyone — and if you build with me, 100% of that $1,500 is credited to the deployment."
        }
      ],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_in_stage:contacted:14",
            "name": "en-entry-breakup-check",
            "subject": "Closing the loop — {{CLIENT_NAME}}",
            "body": "Hi {{CLIENT_NAME}},\n\nI have not heard back, so I will assume {{PAIN_CATEGORY}} is not a priority right now and close this out on my end. If you want the diagnostic blueprint later, just reply here.\n\nBest,\nDario",
            "cooldown_days": 30
          }
        ]
      }
    },
    "yes": {
      "what_to_do": [
        "Advance client from 'yes' to 'scheduled' once the 20-minute Discovery Call ($0) is booked.",
        "Pull the recommended discovery worksheet into client_assets.",
        "Identify team size (<20 vs 20–200+) and workflow determinism to route to Track 1 or Track 2 after the call."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "20-min Discovery Call — {{CLIENT_NAME}}",
          "script": "Hi {{CLIENT_NAME}},\n\nGlad this is relevant. Let's keep our 20-minute call strictly focused on three things:\n1. Where leads or tasks currently stall in your {{PAIN_CATEGORY}} flow.\n2. Your current stack ({{TECH_STACK}}).\n3. Whether this fits a fixed-price Owned Workflow (Track 1) or a multi-agent Mach 1 Tower setup (Track 2).\n\nWhat two time slots work best for you this week?\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Do not quote a final build price before mapping their current tools and edge cases on the call."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "diagnose": {
      "what_to_do": [
        "Conduct the Architecture & Readiness Review ($1,500).",
        "Deliver the 1-page diagnosis, system diagram, and Track 1 vs Track 2 recommendation.",
        "Advance stage to 'proposal' with the $1,500 credit applied."
      ],
      "what_to_say": [
        {
          "channel": "call",
          "script": "Walk me through the last three times a lead or request came in: where did it land, who touched it manually, how long did it sit, and where did data get re-typed?"
        }
      ],
      "what_not_to_say": [
        "Never recommend Track 2 (Mach 1 Tower) if a single deterministic n8n/Python workflow solves 95% of the problem for a team under 20 people."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "proposal": {
      "what_to_do": [
        "Send the Architecture & Readiness Review invoice ($1,500) or transition directly to Track 1 / Track 2 proposal.",
        "Explicitly state the 100% ($1,500) credit rule on the proposal."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Architecture & Readiness Review — {{CLIENT_NAME}}",
          "script": "Hi {{CLIENT_NAME}},\n\nAttached is the scope for your Architecture & Readiness Review ($1,500 flat).\n\nDeliverables within 5 business days:\n- End-to-end bottleneck audit of your {{PAIN_CATEGORY}} workflow\n- Target architecture & tool selection\n- Fixed-price build proposal (with 100% of this $1,500 credited toward implementation)\n\nOnce payment clears, we kick off immediately.\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Do not start architecture diagramming before the $1,500 invoice is paid."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "invoice-reminder"
        ],
        "worksheets": [],
        "triggers": []
      }
    }
  }
},
{
  "id": "en-track1-owned-workflows",
  "title": "EN Track 1 — Owned Workflows (n8n / Windmill / Python)",
  "match": {
    "languages": [
      "en"
    ],
    "tracks": [
      "track_1"
    ],
    "verticals": [
      "*"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Track 1: Owned Workflows",
    "currency": "USD",
    "setup_price": "$4,000 single workflow / from $9,000 multi-workflow",
    "recurring_price": "$450/mo Owned System Care (optional)",
    "credit_rule": "If client completed the $1,500 Architecture & Readiness Review, deduct $1,500 from the setup fee."
  },
  "stages": {
    "scouted": {
      "what_to_do": [
        "Enrich client to confirm headcount (<20 staff) and deterministic workflow fit.",
        "Verify email and tech stack."
      ],
      "what_to_say": [],
      "what_not_to_say": [
        "Never pitch Mach 1 Tower ($1,000/mo platform) to a small team that only needs deterministic n8n/Python automation."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Review Touch 1 outreach draft highlighting full code/workflow ownership and zero vendor lock-in.",
        "Approve and send via Resend."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Fixing {{PAIN_CATEGORY}} at {{CLIENT_NAME}} (fixed scope, full ownership)",
          "script": "Hi {{CLIENT_NAME}},\n\nLooking at {{CLIENT_NAME}}, your {{PAIN_CATEGORY}} process looks like a classic deterministic bottleneck: repetitive intake, routing, and follow-up eating hours every week.\n\nI build Track 1 Owned Workflows (n8n, Windmill, or Python) deployed directly on your own infrastructure:\n- Fixed scope & upfront price ($4,000 for a single workflow; from $9,000 multi-workflow)\n- Delivered in days, not months\n- 100% owned by you with full runbooks and handover docs — zero vendor lock-in\n\nOpen to a 20-minute call this week to map the exact workflow?\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Never use EUR prices.",
        "Never pitch monthly SaaS lock-in."
      ],
      "objection_handlers": [
        {
          "objection": "Can't we just use Zapier?",
          "reply": "Zapier works for 2-step triggers, but breaks down on branching logic, retries, PII hygiene, and per-task fees at scale. An owned n8n/Windmill/Python pipeline runs on your infra with zero per-task tax and full audit logs."
        }
      ],
      "auto_bundle": {
        "templates": [
          "lead-capture-webhook"
        ],
        "worksheets": [],
        "triggers": []
      }
    },
    "diagnose": {
      "what_to_do": [
        "Map inputs, triggers, error paths, and target CRM/email endpoints.",
        "Decide between Single Workflow ($4,000) and Multi-Workflow ($9,000+)."
      ],
      "what_to_say": [
        {
          "channel": "call",
          "script": "Let's list every input source, the exact decision rules for routing, and what happens when an API fails or a record is incomplete. Everything we lock here goes into the fixed-scope spec."
        }
      ],
      "what_not_to_say": [
        "Do not promise un-scoped custom UI dashboards inside a $4,000 single-workflow build."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "proposal": {
      "what_to_do": [
        "Finalize `proposal.md` with exact deliverables, timeline (days), and price ($4,000 single or $9,000+ multi).",
        "Include optional $450/mo Owned System Care SLA.",
        "Attach `invoice-reminder` template for deposit tracking."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Fixed-Scope Proposal — {{CLIENT_NAME}} (Owned Workflow)",
          "script": "Hi {{CLIENT_NAME}},\n\nHere is the fixed-scope proposal for {{CLIENT_NAME}}:\n\n- Track: Track 1 — Owned Workflows (deployed on your infra)\n- Investment: {{SETUP_PRICE}}\n- Optional Care: $450/mo Owned System Care (monitoring, API drift fixes, monthly tuning)\n- Handover: Full source code, `.env.example`, and signed `CLIENT_SOP_HANDOVER.md`\n\nReply 'approved' and I will send the kickoff invoice so we can start immediately.\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Never start writing production code before deposit payment clears."
      ],
      "objection_handlers": [
        {
          "objection": "Do we have to pay the $450/mo retainer?",
          "reply": "No. Owned System Care ($450/mo) is completely optional. You own the code and runbooks outright, so your team can maintain it independently from day one."
        }
      ],
      "auto_bundle": {
        "templates": [
          "invoice-reminder"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_in_stage:proposal:5",
            "name": "en-track1-proposal-nudge",
            "subject": "Re: Fixed-Scope Proposal — {{CLIENT_NAME}}",
            "body": "Hi {{CLIENT_NAME}},\n\nChecking in on the Owned Workflow proposal. Happy to walk through the technical scope or adjust phases if you want to start with a single $4,000 workflow first.\n\nBest,\nDario",
            "cooldown_days": 7
          }
        ]
      }
    },
    "payment": {
      "what_to_do": [
        "Verify payment in CRM via record_payment.",
        "Instantiate client deliverables in ~/.ai-enablement-agent/deliverables/<id>/.",
        "Build, test, and deploy workflow on client infrastructure."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Kickoff confirmed — {{CLIENT_NAME}}",
          "script": "Hi {{CLIENT_NAME}},\n\nPayment received — thank you. Kickoff starts today. Please share the environment credentials via our secure channel so I can deploy and test the pipeline.\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Never ask clients to paste plaintext API keys or passwords inside regular email threads."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "done": {
      "what_to_do": [
        "Run `handover` tool to generate and Ed25519-sign `CLIENT_SOP_HANDOVER.md`.",
        "Verify zero secrets are leaked in handover docs.",
        "Schedule +14 day post-handover check-in and pitch Owned System Care ($450/mo) or AKLI Team ($4/seat/mo) if relevant."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Handover complete — {{CLIENT_NAME}} production runbook",
          "script": "Hi {{CLIENT_NAME}},\n\nYour workflow is live in production. I have attached your signed `CLIENT_SOP_HANDOVER.md` covering architecture, environment variables, run/check commands, and recovery steps.\n\nI will check back in two weeks to verify everything is running smoothly.\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "review-request-sequence"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_after_handover:14",
            "name": "en-track1-post-handover-check",
            "subject": "2-week check-in — {{CLIENT_NAME}}",
            "body": "Hi {{CLIENT_NAME}},\n\nYour automation has been live for two weeks. How are the runs looking on your end? If you would like ongoing monitoring and drift protection under Owned System Care ($450/mo), just let me know.\n\nBest,\nDario",
            "cooldown_days": 30
          }
        ]
      }
    }
  }
},
{
  "id": "en-track2-mach1-tower",
  "title": "EN Track 2 — Mach 1 Tower Multi-Agent Orchestration",
  "match": {
    "languages": [
      "en"
    ],
    "tracks": [
      "track_2"
    ],
    "verticals": [
      "*"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Track 2: Mach 1 Tower",
    "currency": "USD",
    "setup_price": "$5,000 single-agent deploy / from $10,000 org-wide deploy",
    "recurring_price": "$1,000/mo platform + $0.025/step (Mach 1) + from $1,500/mo Managed or Enablement retainer (Dario)",
    "credit_rule": "100% of the $1,500 Architecture & Readiness Review credited to deployment. Org-wide deals eligible for Mach 1 FDE co-engineering."
  },
  "stages": {
    "scouted": {
      "what_to_do": [
        "Enrich organization to confirm 20–200+ headcount, multi-system complexity, or messy cross-team workflows.",
        "Identify VP Ops, COO, Managing Partner, or Head of Revenue."
      ],
      "what_to_say": [],
      "what_not_to_say": [
        "Never pitch Track 1 single scripts to a 50+ person org with cross-department state and approval gates.",
        "Never use EUR prices."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Position Mach 1 Tower production agentic orchestration with approval gates, evals, and full handover.",
        "Approve and send Touch 1."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Production agentic orchestration for {{CLIENT_NAME}}'s {{PAIN_CATEGORY}}",
          "script": "Hi {{CLIENT_NAME}},\n\nAt {{CLIENT_NAME}}'s scale, brittle point-to-point scripts break as soon as sales, support, and CRM states diverge.\n\nAs an official Mach 1 Partner, I deploy production Tower agent systems with human approval gates, deterministic evaluation, and full operational handover:\n- Single-agent deployment: $5,000 | Org-wide deployment: from $10,000\n- Platform: $1,000/mo + $0.025/step (direct to Mach 1) + optional Managed/Enablement retainer from $1,500/mo\n\nOpen to a 20-minute architecture call this week to map your highest-leverage agent boundary?\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Never hide the $1,000/mo + $0.025/step Mach 1 platform fee — state it transparently up front.",
        "Never promise autonomous outbound or unapproved customer actions without approval gates."
      ],
      "objection_handlers": [
        {
          "objection": "Why not build our own agent framework on LangChain/CrewAI?",
          "reply": "Building an internal agent runtime means owning state persistence, retries, approval queues, observability, and model drift forever. Mach 1 Tower gives you production governance out of the box so we ship business workflows in days instead of burning 6 months on plumbing."
        },
        {
          "objection": "How do you handle sensitive client data and PII?",
          "reply": "Every deployment includes strict tool-scoping, human approval gates on external actions, and optional AKLI Team DLP ($4/seat/mo, $3 at 50+ seats) to block PII leaks across browser AI tools."
        }
      ],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "diagnose": {
      "what_to_do": [
        "Define agent boundaries, tool permissions, human approval gates, and evaluation benchmarks.",
        "Decide whether org-wide scope warrants Mach 1 Forward Deployed Engineer (FDE) co-engineering."
      ],
      "what_to_say": [
        {
          "channel": "call",
          "script": "Let's separate decisions an agent can execute autonomously from high-stakes actions—like sending quotes, issuing refunds, or updating billing—that require a human approval gate."
        }
      ],
      "what_not_to_say": [
        "Never deploy an agent without explicit approval gates on external communications or financial mutations."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "proposal": {
      "what_to_do": [
        "Separate setup fees ($5,000 single-agent / from $10,000 org-wide) from Mach 1 platform costs ($1,000/mo + $0.025/step) and Dario's Managed/Enablement retainer (from $1,500/mo).",
        "Include AKLI Team ($4/seat/mo, $3 at 50+) as an optional security add-on."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Track 2 Mach 1 Tower Proposal — {{CLIENT_NAME}}",
          "script": "Hi {{CLIENT_NAME}},\n\nAttached is the Track 2 Mach 1 Tower deployment proposal for {{CLIENT_NAME}}:\n\n1. Deployment Setup: {{SETUP_PRICE}} (fixed scope, includes approval gates, eval suite, and team handover)\n2. Mach 1 Tower Platform: $1,000/mo + $0.025/step (billed directly by Mach 1)\n3. Managed / Enablement Retainer: from $1,500/mo (continuous eval tuning, new agent skills, SLA)\n4. Optional Security Add-on: AKLI Team DLP ($4/seat/mo; $3/seat/mo at 50+ seats)\n\nLet me know once reviewed so we can lock the kickoff date.\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [
        "Never bundle Mach 1 usage fees into Dario's setup invoice — keep platform billing transparent."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "invoice-reminder"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_in_stage:proposal:5",
            "name": "en-track2-proposal-followup",
            "subject": "Re: Track 2 Mach 1 Tower Proposal — {{CLIENT_NAME}}",
            "body": "Hi {{CLIENT_NAME}},\n\nFollowing up on the Mach 1 Tower proposal. If you want to start with a $5,000 single-agent deployment on {{PAIN_CATEGORY}} before expanding org-wide, we can phase it cleanly.\n\nBest,\nDario",
            "cooldown_days": 7
          }
        ]
      }
    },
    "payment": {
      "what_to_do": [
        "Record setup payment in CRM.",
        "Provision Mach 1 Tower workspace and configure approval gates + eval harness.",
        "If FDE-assisted org-wide deal, coordinate kickoff with Mach 1 FDE team."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Tower deployment kickoff — {{CLIENT_NAME}}",
          "script": "Hi {{CLIENT_NAME}},\n\nKickoff is confirmed. We are provisioning your Mach 1 Tower instance and configuring the initial tool connectors and approval gates this week.\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "done": {
      "what_to_do": [
        "Generate signed `CLIENT_SOP_HANDOVER.md`.",
        "Run live team enablement session and verify approval gates in production.",
        "Activate Managed/Enablement retainer ($1,500/mo+)."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Production handover — {{CLIENT_NAME}} Mach 1 Tower",
          "script": "Hi {{CLIENT_NAME}},\n\nYour Mach 1 Tower deployment is live with all evaluation checks passing. Attached is your signed operational runbook (`CLIENT_SOP_HANDOVER.md`).\n\nBest,\nDario"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "review-request-sequence"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_after_handover:14",
            "name": "en-track2-eval-review",
            "subject": "14-day agent evaluation & step audit — {{CLIENT_NAME}}",
            "body": "Hi {{CLIENT_NAME}},\n\nWe are two weeks into production on Tower. Let's review your step logs, approval gate hit rates, and next workflow candidate.\n\nBest,\nDario",
            "cooldown_days": 30
          }
        ]
      }
    }
  }
},
{
  "id": "it-entry-diagnosi",
  "title": "IT Entry — Diagnosi Operativa PMI (€400)",
  "match": {
    "languages": [
      "it"
    ],
    "tracks": [
      "entry"
    ],
    "verticals": [
      "*"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Entry — IT PMI Diagnosi",
    "currency": "EUR",
    "setup_price": "€400 IT PMI Diagnosi",
    "recurring_price": "€0",
    "credit_rule": "La Diagnosi PMI (€400) definisce il perimetro esatto prima di avviare il Percorso 1 (Workflow di Proprietà) o il Percorso 2 (Mach 1 Tower)."
  },
  "stages": {
    "scouted": {
      "what_to_do": [
        "Eseguire enrich_client per verificare sito, email aziendale, dimensione team e processi manuali.",
        "Impostare language='it' sul record cliente."
      ],
      "what_to_say": [],
      "what_not_to_say": [
        "Non usare anglicismi inutili o fuffa da agenzia marketing.",
        "Non proporre progetti complessi prima di capire quanti dipendenti ha l'azienda."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Personalizzare l'apertura della bozza con un dettaglio concreto trovato sul sito dell'azienda.",
        "Approvare e inviare il primo contatto."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Nota veloce su {{CLIENT_NAME}} — gestione {{PAIN_CATEGORY}}",
          "script": "Buongiorno,\n\nHo analizzato come {{CLIENT_NAME}} gestisce attualmente {{PAIN_CATEGORY}} nel settore {{VERTICAL}} — è esattamente il tipo di collo di bottiglia operativo su cui lavoro.\n\nPrima di proporre qualsiasi sviluppo, realizzo una Diagnosi Operativa PMI a prezzo fisso (€400): mappiamo dove si perdono richieste o ore di lavoro manuale e consegno un piano tecnico concreto con costi certi e zero vincoli.\n\nHa senso sentirci 20 minuti questa settimana per capire se fa al caso vostro?\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [
        "Non promettere 'intelligenza artificiale magica' o risparmi irrealistici.",
        "Non inviare email senza aver verificato persona e azienda."
      ],
      "objection_handlers": [
        {
          "objection": "Abbiamo già un gestionale / CRM.",
          "reply": "Il problema quasi mai è il gestionale in sé, ma il lavoro manuale tra email, WhatsApp, moduli web e gestionale. La diagnosi serve proprio a collegare ciò che avete già senza buttare via nulla."
        },
        {
          "objection": "Perché la diagnosi costa €400?",
          "reply": "Perché non è una chiamata commerciale: analizzo i vostri flussi reali e vi consegno un documento tecnico con architettura, priorità e preventivo fisso, utilizzabile anche con altri fornitori."
        }
      ],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_in_stage:contacted:14",
            "name": "it-entry-chiusura",
            "subject": "Ultimo aggiornamento — {{CLIENT_NAME}}",
            "body": "Buongiorno,\n\nNon avendo ricevuto risposta immagino che ottimizzare {{PAIN_CATEGORY}} non sia una priorità in questo momento. Chiudo qui il follow-up; se dovesse tornare utile più avanti, risponda pure a questa email.\n\nUn saluto,\nDario Cositore",
            "cooldown_days": 30
          }
        ]
      }
    },
    "yes": {
      "what_to_do": [
        "Fissare la call conoscitiva di 20 minuti e spostare lo stato su 'scheduled'.",
        "Preparare le domande specifiche sul flusso operativo."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Call conoscitiva 20 min — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nOttimo, facciamo una call operativa di 20 minuti per vedere:\n1. Dove si bloccano oggi richieste o attività su {{PAIN_CATEGORY}}.\n2. Quali strumenti usate già ({{TECH_STACK}}).\n3. Se conviene procedere con la Diagnosi PMI (€400) o direttamente con un intervento mirato.\n\nQuali fasce orarie preferite questa settimana?\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "diagnose": {
      "what_to_do": [
        "Eseguire la Diagnosi PMI (€400) e consegnare report scritto con stima tempi/costi.",
        "Instradare il cliente su Percorso 1 (<20 persone / flussi lineari) o Percorso 2 (20–200+ persone / orchestrazione multi-agente)."
      ],
      "what_to_say": [
        {
          "channel": "call",
          "script": "Ricostruiamo gli ultimi tre casi reali: da dove è arrivata la richiesta, chi l'ha gestita a mano, quanto tempo è passato e dove sono stati ricopiati i dati."
        }
      ],
      "what_not_to_say": [
        "Non proporre Mach 1 Tower se un singolo workflow n8n/Python risolve il problema."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "invoice-reminder"
        ],
        "worksheets": [],
        "triggers": []
      }
    }
  }
},
{
  "id": "it-track1-percorso1-owned",
  "title": "IT Percorso 1 — Workflow di Proprietà (n8n / Windmill / Python)",
  "match": {
    "languages": [
      "it"
    ],
    "tracks": [
      "track_1"
    ],
    "verticals": [
      "*"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Percorso 1: Workflow di Proprietà",
    "currency": "EUR",
    "setup_price": "€1.500 base / €2.500 CRM / €3.500 docs",
    "recurring_price": "€150–€250/mo Assistenza (opzionale)",
    "credit_rule": "Prezzo fisso chiavi in mano: €1.500 automazione base, €2.500 integrazione CRM/intake, €3.500 pipeline documentale."
  },
  "stages": {
    "scouted": {
      "what_to_do": [
        "Arricchire il contatto per confermare dimensione PMI (<20 dipendenti) e tipologia processo (base, CRM o documenti).",
        "Verificare email diretta."
      ],
      "what_to_say": [],
      "what_not_to_say": [
        "Non proporre canoni SaaS vincolanti: il punto di forza del Percorso 1 è la proprietà totale del codice."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Selezionare la fascia corretta del Percorso 1: €1.500 base, €2.500 CRM, o €3.500 documenti.",
        "Revisionare e approvare la bozza Touch 1."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Automatizzare {{PAIN_CATEGORY}} in {{CLIENT_NAME}} (prezzo fisso, zero vincoli)",
          "script": "Buongiorno,\n\nGuardando come opera {{CLIENT_NAME}}, la gestione di {{PAIN_CATEGORY}} ha tutti i segnali di un flusso che può essere automatizzato in modo deterministico senza cambiare i vostri strumenti.\n\nCon il Percorso 1 (Workflow di Proprietà su n8n/Python) realizzo la pipeline completa a prezzo fisso:\n- €1.500 automazione base | €2.500 integrazione CRM/intake | €3.500 gestione documenti\n- Consegna in giorni, non mesi\n- Codice, credenziali e manuale operativo restano al 100% di vostra proprietà, senza abbonamenti obbligatori\n\nHa senso parlarne 20 minuti questa settimana?\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [
        "Non usare prezzi in dollari per il Percorso 1 italiano.",
        "Non parlare di 'pilot' sperimentali: consegnamo sistemi finiti in produzione."
      ],
      "objection_handlers": [
        {
          "objection": "E se poi cambia qualcosa nelle API o serve manutenzione?",
          "reply": "Il sistema è vostro e documentato. Se preferite non pensarci, c'è il piano Assistenza opzionale da €150–€250/mese per monitoraggio e aggiornamenti, attivabile o disattivabile quando volete."
        }
      ],
      "auto_bundle": {
        "templates": [
          "lead-capture-webhook"
        ],
        "worksheets": [],
        "triggers": []
      }
    },
    "diagnose": {
      "what_to_do": [
        "Definire input, regole di smistamento, gestione errori e integrazioni.",
        "Confermare fascia prezzo (€1.500 / €2.500 / €3.500) e canone Assistenza (€150–€250/mo)."
      ],
      "what_to_say": [
        {
          "channel": "call",
          "script": "Fissiamo esattamente cosa entra nel flusso, quali controlli automatici servono e dove devono arrivare i dati puliti. Tutto viene messo nero su bianco a preventivo fisso."
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "proposal": {
      "what_to_do": [
        "Inviare proposta a prezzo fisso (€1.500 base / €2.500 CRM / €3.500 docs) con consegna prevista e manuale di handover.",
        "Preparare promemoria fattura con `invoice-reminder`."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Proposta operativa a prezzo fisso — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nIn allegato la proposta operativa per {{CLIENT_NAME}}:\n\n- Soluzione: {{TRACK_NAME}} (installato sulla vostra infrastruttura)\n- Investimento una tantum: {{SETUP_PRICE}}\n- Assistenza opzionale: €150–€250/mese (monitoraggio continuo e adeguamento API)\n- Consegna: sistema in produzione + documento firmato `CLIENT_SOP_HANDOVER.md`\n\nAppena confermata, invio la fattura di avvio lavori.\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [
        "Non avviare lo sviluppo prima del saldo acconto."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "invoice-reminder"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_in_stage:proposal:5",
            "name": "it-track1-sollecito-proposta",
            "subject": "Re: Proposta operativa a prezzo fisso — {{CLIENT_NAME}}",
            "body": "Buongiorno,\n\nUn veloce aggiornamento sulla proposta inviata. Se preferisce partire da un primo modulo base da €1.500 per testare subito il risultato, possiamo suddividere il lavoro in due fasi.\n\nUn saluto,\nDario Cositore",
            "cooldown_days": 7
          }
        ]
      }
    },
    "payment": {
      "what_to_do": [
        "Registrare pagamento con `record_payment`.",
        "Generare i deliverable nella cartella cliente e avviare lo sviluppo."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Avvio lavori confermato — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nPagamento ricevuto, grazie. Avvio oggi la configurazione della pipeline. Le invio a breve l'elenco delle chiavi API/accessi necessari da condividere in modo sicuro.\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [
        "Non chiedere password in chiaro via email."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "done": {
      "what_to_do": [
        "Generare `CLIENT_SOP_HANDOVER.md` firmato con il tool `handover`.",
        "Consegnare documentazione e programmare verifica a +14 giorni."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Consegna in produzione e manuale operativo — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nIl workflow è attivo in produzione. In allegato trova il manuale operativo firmato (`CLIENT_SOP_HANDOVER.md`) con architettura, variabili d'ambiente e procedure di verifica.\n\nCi aggiorniamo tra due settimane per controllare insieme i primi log.\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "review-request-sequence"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_after_handover:14",
            "name": "it-track1-check-14gg",
            "subject": "Verifica a 2 settimane — {{CLIENT_NAME}}",
            "body": "Buongiorno,\n\nSono passate due settimane dall'attivazione del flusso. Come stanno andando le esecuzioni? Se desidera attivare il piano Assistenza (€150–€250/mese) per il monitoraggio continuo, mi faccia sapere.\n\nUn saluto,\nDario Cositore",
            "cooldown_days": 30
          }
        ]
      }
    }
  }
},
{
  "id": "it-track2-percorso2-tower",
  "title": "IT Percorso 2 — Mach 1 Tower Orchestrazione Multi-Agente",
  "match": {
    "languages": [
      "it"
    ],
    "tracks": [
      "track_2"
    ],
    "verticals": [
      "*"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Percorso 2: Mach 1 Tower",
    "currency": "EUR",
    "setup_price": "Audit €1.500 | Deploy da €4.500 (multi-agente da €9.000)",
    "recurring_price": "Tower $1.000/mo + $0,025/step + Retainer da €1.500/mo",
    "credit_rule": "Audit €1.500 propedeutico al deploy. Per progetti enterprise multi-reparto è disponibile il co-engineering con i Forward Deployed Engineers di Mach 1."
  },
  "stages": {
    "scouted": {
      "what_to_do": [
        "Arricchire l'azienda per confermare struttura 20–200+ dipendenti o processi complessi tra vendite, supporto e CRM.",
        "Individuare COO, Direttore Operativo, Managing Partner o Responsabile Commerciale."
      ],
      "what_to_say": [],
      "what_not_to_say": [
        "Non proporre singole macro artigianali a strutture sopra i 20 dipendenti che richiedono permessi, audit log e approvazione umana."
      ],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Posizionare la partnership ufficiale Mach 1 Tower per l'Italia/Europa con focus su governance, approval gate e handover.",
        "Approvare e inviare il primo contatto."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Orchestrazione agenti AI in produzione per {{CLIENT_NAME}} (Mach 1 Tower)",
          "script": "Buongiorno,\n\nIn organizzazioni delle dimensioni di {{CLIENT_NAME}}, gli script lineari si bloccano appena aumentano le eccezioni tra vendite, assistenza clienti e CRM.\n\nCome Partner ufficiale Mach 1 per l'Italia, progetto e metto in produzione sistemi multi-agente su Mach 1 Tower con approvazione umana obbligatoria sulle azioni critiche, test di valutazione e handover completo:\n- Audit iniziale: €1.500 | Deploy singolo agente: da €4.500 (multi-agente: da €9.000)\n- Piattaforma Tower: $1.000/mese + $0,025/step + Retainer di gestione/enablement da €1.500/mese\n\nHa senso dedicare 20 minuti questa settimana per valutare il primo caso d'uso?\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [
        "Non nascondere il costo piattaforma Tower ($1.000/mo + $0,025/step): va esplicitato subito.",
        "Non proporre agenti che inviano comunicazioni o modificano pagamenti senza approval gate."
      ],
      "objection_handlers": [
        {
          "objection": "E la conformità GDPR / sicurezza dati aziendali?",
          "reply": "Ogni agente su Tower opera con permessi granulari, log di audit completi e blocchi di approvazione umana. Inoltre possiamo affiancare AKLI Team ($4/utente/mese, $3 oltre 50 utenti) per prevenire fughe di dati sensibili dai browser del team."
        }
      ],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "diagnose": {
      "what_to_do": [
        "Eseguire l'Audit (€1.500) mappando confini degli agenti, integrazioni API, approval gate e metriche di valutazione.",
        "Valutare coinvolgimento Forward Deployed Engineers (FDE) Mach 1 se il deploy è multi-reparto."
      ],
      "what_to_say": [
        {
          "channel": "call",
          "script": "Separiamo con precisione ciò che l'agente può preparare in autonomia da ciò che richiede il clic di approvazione di un vostro responsabile prima di uscire verso il cliente."
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "proposal": {
      "what_to_do": [
        "Separare chiaramente in proposta: Audit (€1.500), Deploy (da €4.500 / multi da €9.000), Piattaforma Tower ($1.000/mo + $0,025/step) e Retainer (da €1.500/mo).",
        "Allegare `invoice-reminder`."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Proposta Percorso 2 Mach 1 Tower — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nIn allegato la proposta completa per l'implementazione di Mach 1 Tower in {{CLIENT_NAME}}:\n\n1. Audit & Architettura: €1.500\n2. Deploy in produzione: {{SETUP_PRICE}} (include approval gate, test di valutazione e formazione team)\n3. Piattaforma Mach 1 Tower: $1.000/mese + $0,025/step\n4. Retainer Managed / Enablement: da €1.500/mese\n\nResto a disposizione per allinearci sulle tempistiche di avvio.\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "invoice-reminder"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_in_stage:proposal:5",
            "name": "it-track2-sollecito-proposta",
            "subject": "Re: Proposta Percorso 2 Mach 1 Tower — {{CLIENT_NAME}}",
            "body": "Buongiorno,\n\nFaccio seguito alla proposta Mach 1 Tower. Se preferite partire dall'Audit da €1.500 e dal primo agente singolo (da €4.500) su {{PAIN_CATEGORY}} prima di estendere agli altri reparti, possiamo strutturarlo in due step.\n\nUn saluto,\nDario Cositore",
            "cooldown_days": 7
          }
        ]
      }
    },
    "payment": {
      "what_to_do": [
        "Registrare incasso in CRM.",
        "Attivare istanza Mach 1 Tower, configurare connettori, approval gate e suite di valutazione."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Avvio deploy Mach 1 Tower — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nConfermo l'avvio operativo. Stiamo configurando l'ambiente Mach 1 Tower e i primi connettori con i relativi gate di approvazione.\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "done": {
      "what_to_do": [
        "Generare `CLIENT_SOP_HANDOVER.md` firmato.",
        "Completare sessione di enablement col team interno e attivare Retainer da €1.500/mo."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Handover produzione Mach 1 Tower — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nIl sistema su Mach 1 Tower è operativo in produzione con tutti i test superati. In allegato il documento firmato `CLIENT_SOP_HANDOVER.md` con architettura e procedure operative.\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [
          "review-request-sequence"
        ],
        "worksheets": [],
        "triggers": [
          {
            "event": "days_after_handover:14",
            "name": "it-track2-check-14gg",
            "subject": "Revisione metriche a 14 giorni — {{CLIENT_NAME}}",
            "body": "Buongiorno,\n\nSono passate due settimane dal rilascio su Tower. Rivediamo insieme i log degli step, le approvazioni e il prossimo flusso da integrare.\n\nUn saluto,\nDario Cositore",
            "cooldown_days": 30
          }
        ]
      }
    }
  }
}
,
{
  "id": "it-vertical-avvocati",
  "title": "Studi Legali — Intake & CRM AI",
  "match": {
    "languages": [
      "it"
    ],
    "tracks": [
      "track_1",
      "track_2"
    ],
    "verticals": [
      "avvocato",
      "avvocati",
      "legal",
      "law firm",
      "studio legale"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Studi Legali — Intake & CRM AI",
    "currency": "EUR",
    "setup_price": "Percorso 1: €2.500 CRM / €3.500 docs | Percorso 2 (20+ staff): Audit €1.500, Deploy da €4.500 (multi da €9.000)",
    "recurring_price": "€150–€250/mo Assistenza (Percorso 1) | Tower $1.000/mo + $0,025/step + Retainer da €1.500/mo (Percorso 2)",
    "credit_rule": "Diagnosi PMI €400 (o Audit €1.500 per studi strutturati) con architettura fissa prima dello sviluppo."
  },
  "stages": {
    "scouted": {
      "what_to_do": [],
      "what_to_say": [],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Verificare numero avvocati/collaboratori (<20 -> Percorso 1 €2.500–€3.500; 20+ -> Percorso 2 Mach 1 Tower).",
        "Citare il caso studio reale dello studio legale da 30 persone (+45% conversioni qualificate, sync lead-CRM in 10 secondi).",
        "Approvare e inviare Touch 1."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Qualifica richieste e intake clienti per {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nNegli studi legali strutturati, le richieste in arrivo da sito, email e telefono spesso restano ferme ore prima di essere smistate al professionista giusto — facendo perdere incarichi qualificati.\n\nDi recente ho ricostruito la pipeline di intake e CRM per uno studio legale di 30 persone, portando la sincronizzazione lead-CRM a 10 secondi e aumentando del +45% le conversioni qualificate, senza cambiare il gestionale esistente.\n\nLavoro a perimetro e prezzo fisso (Percorso 1 da €2.500 per studi snelli, oppure orchestrazione Mach 1 Tower con approvazione umana per studi oltre 20 persone), con consegna completa di codice e manuali.\n\nHa senso sentirci 20 minuti questa settimana per vedere come gestite oggi il primo contatto?\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [
        "Mai proporre che l'AI dia pareri legali o risponda ai clienti senza approvazione umana (approval gate obbligatorio).",
        "Mai chiedere di sostituire il gestionale legale già in uso: ci integriamo sopra."
      ],
      "objection_handlers": [
        {
          "objection": "Abbiamo vincoli stringenti di riservatezza e deontologia.",
          "reply": "Il sistema gestisce solo triage amministrativo, raccolta dati anagrafici e smistamento interno con log di audit completi e approvazione umana prima di qualsiasi invio esterno. Nessun dato viene usato per addestrare modelli."
        }
      ],
      "auto_bundle": {
        "templates": [
          "lead-capture-webhook"
        ],
        "worksheets": [],
        "triggers": []
      }
    }
  }
},
{
  "id": "it-vertical-cliniche",
  "title": "Cliniche & Studi Medici — Percorso 1 Intake & Recensioni",
  "match": {
    "languages": [
      "it"
    ],
    "tracks": [
      "track_1"
    ],
    "verticals": [
      "dentista",
      "dentisti",
      "clinica",
      "cliniche",
      "medico",
      "poliambulatorio",
      "healthcare",
      "clinic",
      "dental"
    ],
    "pain_categories": [
      "*"
    ]
  },
  "pricing": {
    "track_name": "Cliniche & Studi Medici — Percorso 1 Intake & Recensioni",
    "currency": "EUR",
    "setup_price": "€1.500 base / €2.500 CRM & agenda / €3.500 referti & docs",
    "recurring_price": "€150–€250/mo Assistenza (opzionale)",
    "credit_rule": "Diagnosi Operativa PMI €400 oppure avvio diretto a prezzo fisso chiavi in mano."
  },
  "stages": {
    "scouted": {
      "what_to_do": [],
      "what_to_say": [],
      "what_not_to_say": [],
      "objection_handlers": [],
      "auto_bundle": {
        "templates": [],
        "worksheets": [],
        "triggers": []
      }
    },
    "enriched": {
      "what_to_do": [
        "Controllare se la struttura ha form online lenti, segreteria intasata o poche recensioni Google rispetto ai competitor in zona.",
        "Preparare proposta centrata su recupero chiamate perse, conferma appuntamenti e sequenza recensioni post-visita.",
        "Approvare e inviare Touch 1."
      ],
      "what_to_say": [
        {
          "channel": "email",
          "subject": "Gestione richieste pazienti e segreteria — {{CLIENT_NAME}}",
          "script": "Buongiorno,\n\nIn molte cliniche e studi medici la segreteria perde decine di ore tra chiamate non risposte, richieste informazioni ripetitive e follow-up manuali sui preventivi.\n\nRealizzo automazioni deterministiche a prezzo fisso (€1.500 base / €2.500 integrazione CRM e richieste / €3.500 flussi documentali) che smistano le richieste pazienti in tempo reale e automatizzano i promemoria e le recensioni post-visita — senza toccare dati clinici sensibili e lasciando al vostro team il 100% della proprietà del sistema.\n\nPossiamo fare una call operativa di 20 minuti questa settimana?\n\nUn saluto,\nDario Cositore"
        }
      ],
      "what_not_to_say": [
        "Mai far transitare anamnesi, referti o dati sanitari ex art. 9 GDPR dentro prompt LLM esterni o email non cifrate.",
        "Mai promettere diagnosi o triage clinico automatizzato: solo gestione amministrativa appuntamenti e segreteria."
      ],
      "objection_handlers": [
        {
          "objection": "Come viene gestita la privacy sanitaria (GDPR)?",
          "reply": "Separiamo nettamente il flusso amministrativo (nome, contatto, fascia oraria, tipo visita) dalla cartella clinica: nessun dato sanitario transita sui modelli AI e l'infrastruttura resta sotto il vostro controllo."
        }
      ],
      "auto_bundle": {
        "templates": [
          "lead-capture-webhook",
          "review-request-sequence"
        ],
        "worksheets": [],
        "triggers": []
      }
    }
  }
}
]

export function seedPlaybooks(): string[] {
  ensureDir()
  const seeded: string[] = []
  for (const pb of CURATED_PLAYBOOKS) {
    const f = path.join(playbooksDir(), `${pb.id}.json`)
    if (fs.existsSync(f)) continue
    fs.writeFileSync(f, JSON.stringify(pb, null, 2), { mode: 0o644 })
    seeded.push(pb.id)
  }
  return seeded
}

export function renderPlaceholders(text: string, ctx: Record<string, string>): string {
  let out = text
  for (const [k, v] of Object.entries(ctx)) {
    out = out.split(`{{${k}}}`).join(v)
  }
  return out
}

export function resolvePlaybook(clientId: number): CasePlaybook | null {
  const client = getClient(clientId)
  if (!client) return null
  const { track } = routeClientTrack(client)
  const lang = client.language === "it" ? "it" : "en"
  const v = (client.vertical || "").toLowerCase().trim()

  // Exact vertical override takes priority over "*" wildcard playbooks.
  if (v) {
    const verticalMatch = CURATED_PLAYBOOKS.find((pb) => {
      if (!pb.match.languages.includes(lang)) return false
      if (!pb.match.tracks.includes(track)) return false
      return pb.match.verticals.some((x) => x.toLowerCase() === v)
    })
    if (verticalMatch) {
      const pb = loadPlaybook(verticalMatch.id) ?? verticalMatch
      return pb
    }
    // partial/contains match
    const partial = CURATED_PLAYBOOKS.find((pb) => {
      if (!pb.match.languages.includes(lang)) return false
      if (!pb.match.tracks.includes(track)) return false
      return pb.match.verticals.some((x) => x !== "*" && (v.includes(x.toLowerCase()) || x.toLowerCase().includes(v)))
    })
    if (partial) {
      const pb = loadPlaybook(partial.id) ?? partial
      return pb
    }
  }

  // Map routing track + language to curated playbook id.
  let id: string
  const t = String(track)
  if (lang === "it") {
    if (t === "it_local_audit_150" || t === "it_pmi_diagnosi_400") id = "it-entry-diagnosi"
    else if (t.startsWith("it_pmi_track1") || t === "it_local_micro_490") id = "it-track1-percorso1-owned"
    else id = "it-track2-percorso2-tower"
  } else {
    if (t === "en_discovery_0") id = "en-entry-diagnostic"
    else if (t === "en_track1_4000") id = "en-track1-owned-workflows"
    else id = "en-track2-mach1-tower"
  }
  let pb = loadPlaybook(id)
  if (!pb) {
    for (const f of listPlaybooks()) {
      const p = loadPlaybook(f)
      if (p && p.match.languages.includes(lang) && p.match.tracks.includes(track)) {
        // prefer "*" vertical match
        if (p.match.verticals.includes("*") || p.match.verticals.includes(v)) { pb = p; break }
        if (!pb) pb = p
      }
    }
  }
  return pb
}

// ---------------------------------------------------------------------------
// generateClientCallPlaybook (beam-free, no Mach 1 Tower dependency)
// ---------------------------------------------------------------------------

export async function generateClientCallPlaybook(clientId: number): Promise<{ markdown: string; assetId?: number }> {
  const { getClient, addAsset } = await import("./crm.js")
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)

  let apiKey = process.env.OPENCODE_API_KEY?.trim() || ""
  if (!apiKey) {
    try {
      const Database = (await import("bun:sqlite")).default
      const dbPath = process.env.OPENCODE_DB || ((process.env.HOME || "") + "/.ai-enablement-agent/home/data/enablement.db")
      const db = new (Database as any)(dbPath, { readonly: true })
      const row = db.query("SELECT value FROM credential WHERE id LIKE 'cred_%opencode%' OR json_extract(value, '$.metadata.orgID') IS NOT NULL").get() as any
      if (row?.value) {
        const cred = JSON.parse(row.value)
        if (cred.access) apiKey = cred.access
      }
      db.close()
    } catch { /* ignore */ }
  }

  const systemPrompt = `You are Dario Cositore's call strategist. Produce a structured Markdown call playbook. Respect copy rules: Italian must never use "flusso/flussi/AI" (use automazione/sistema/motore/processo); English must avoid delve/foster/utilize/leverage/underscore/navigate/resonate/paramount/pivotal/seamless/robust/dynamic/multifaceted/tapestry/beacon/compass/symphony/landscape/catalyst/testament/unlock/unleash/supercharge. No anti-AI vocabulary. Output Markdown only.`

  const userPrompt = `Client: ${client.name}
Vertical: ${client.vertical ?? "unknown"}
Language: ${client.language ?? "en"}
Address: ${client.address ?? "unknown"}
Website: ${client.website ?? "none"}
Offer track: ${client.offer_track ?? "unknown"}
Offer rationale: ${client.offer_rationale ?? ""}
Business summary: ${client.notes ?? ""}
Tech stack: ${client.tech_stack ?? ""}
Pain category: ${client.pain_category ?? ""}

Produce Markdown with these sections:
1. Contesto & Apertura (30 sec)
2. Domande di Qualifica (5-7 domande mirate)
3. Ancoraggio Offerta & Prezzo
4. Gestione Obiezioni (Top 3)`

  let markdown = ""
  if (apiKey) {
    try {
      const res = await fetch("https://opencode.ai/inference/go/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "x-opencode-session": "elitza-playbook-" + Date.now() },
        body: JSON.stringify({
          model: "beam-free",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          stream: false,
          max_tokens: 16384,
          reasoning_effort: "low",
        }),
      })
      if (res.ok) {
        const data: any = await res.json()
        markdown = data?.choices?.[0]?.message?.content || ""
        if (!markdown.trim()) {
          const rc = data?.choices?.[0]?.message?.reasoning_content || ""
          const m = rc.match(/```(?:markdown)?\n([\s\S]*?)```/) || rc.match(/([\s\S]+)/)
          if (m) markdown = m[1] || m[0]
        }
      }
    } catch (e) { console.error("[playbook] beam error:", String(e)) }
  }
  if (!markdown.trim()) {
    markdown = `# Call Playbook — ${client.name}\n\n## Contesto & Apertura (30 sec)\nHook basato su ${client.website ?? "sito"}.\n\n## Domande di Qualifica\n1. Dove si bloccano i lead?\n2. Quali strumenti usate?\n3. Volume settimanale?\n4. Chi decide?\n5. Urgenza?\n\n## Ancoraggio Offerta & Prezzo\n${client.offer_track ?? "audit"}\n\n## Gestione Obiezioni (Top 3)\n- Prezzo: valore vs costo manuale.\n- Tempo: timeline chiara.\n- Fiducia: garanzia.`
  }

  let assetId: number | undefined
  try {
    const asset = addAsset(clientId, { kind: "call_playbook", name: `Call Playbook — ${client.name}`, path: undefined, notes: markdown, status: "ready" })
    assetId = asset.id
  } catch (e) { console.error("[playbook] asset error:", String(e)) }

  return { markdown, assetId }
}
