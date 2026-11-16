# Elitza — Change Log (agent-tracked)

This file tracks every change made to Elitza by the agent, so nothing is forgotten.
Entries are appended chronologically. Newest first.

## 2026-10-31 — Cloud storage: connected SQL + continuous backup stream

### Added
- `cloud_accounts` table in crm.db (connected SQL state for cloud sync).
- Cloud functions in crm.ts: connectCloud, disconnectCloud, listCloudAccounts, getCloudAccount, updateCloudSync, uploadBackupToCloud (Google Drive/Dropbox/OneDrive REST), continuousBackupStream (tar + upload to all connected accounts).
- `cloud` tool: connect/disconnect/list/sync/upload.
- Heartbeat pass: continuousBackupStream on every tick (gated by ELITZA_CLOUD_SYNC, default on).
- CRM house: /api/cloud, /api/cloud/connect, /api/cloud/disconnect, /api/cloud/sync endpoints.
- Settings view: Cloud storage section with provider selector, token input, connect/disconnect, sync now, account list.

## 2026-10-31 — Identity reset + AI Enablement knowledge ingestion

### Changed
- SOUL.md rewritten as "Elitza Agent" — expert AI Enablement operator, no companion persona.
- Cleared soul_v2.db memories (memories, memory_links, recall_log, sessions, soul table) — backup at /tmp/scratchpad/backup.
- `brain/ai-enablement-knowledge.md` — comprehensive AI Enablement + CRM knowledge base (22 sections).
- Ingested 22 semantic memories (AI Enablement knowledge + CRM data model/operations).

## 2026-10-31 — Secret weapon: revenue dashboard + weekly digest

### Added
- `revenueStats()` and `weeklyDigest()` in crm.ts — pipeline value, won value, conversion rate, avg deal, MRR estimate, by-status, by-month.
- `revenue` and `digest` tools in tools.ts.
- `/api/revenue` and `/api/digest` endpoints in crmview.ts.
- Revenue view in CRM house: stat cards (pipeline, won, conversion, avg deal, MRR, open/won deals, clients won), by-status table, by-month table, weekly digest generator button.

## 2026-10-31 — Speed pass: trimmed context, faster chat

### Changed
- `context.ts`: reduced memory retrieval (5→2 relevant, 3→1 emotional, 5→3 semantic, 3→2 procedural) and truncated summaries (120→80 chars).
- `crmview.ts`: chat tool-calling loop capped at 3 iterations (was 5); SOUL truncated to 800 chars in standalone fallback.

## 2026-10-31 — Tier 2 batch: CRM upgrade, skill gating, cost tracking, CSV, A/B variants, Attio reskin

### Added
- CRM custom fields (`setCustomField/getCustomFields/deleteCustomField`), deals (`addDeal/updateDeal/listDeals/deleteDeal`), tags (`addTag/removeTag/listTags/allTags`), audit log (`logAudit/listAudit`) in crm.ts; new tables: client_custom_fields, deals, tags, client_tags, audit_log.
- `crm` tool actions: custom_field, deal, tag, tags, audit.
- Cost tracking: `turn_costs` table + `logTurnCost`/`costSummary`; finalize logs token usage; `cost` tool.
- CSV import/export: `exportClientsCSV`/`importClientsCSV` + `csv` tool.
- A/B outreach: `variant` param on writeDraft, `variant` column on pipeline, `variantStats()` + `variants` outreach action.
- Skill evolution gating (Darwin rule): storeProcedural only replaces when new importance is strictly higher.
- CRM reskin: accent shifted to Attio indigo (#5e6ad2); sidebar restructured to Attio sections (Search, Navigation, Records, Lists, Chats, System) per Attio help docs; openCmdk wired.
- CRM functional wiring: every sidebar option now functional — People view (contacts), Companies (board), Deals view (/api/deals), Tasks view (clients with next action), Lists view (tags), Ask Elitza opens chat panel (WebSocket), Settings view (full functional panel), Setup view (web onboarding wizard). Table view toggle (Kanban/Table) with loadTable.
- Settings view: identity, vertical switcher, permission gates, heartbeat status, cost summary (7d), backup button, paths. Backed by /api/settings, /api/settings/vertical, /api/settings/backup.
- Web onboarding: /api/setup and /api/setup/status endpoints; Setup view in CRM house with form collecting name, human, role, voice, initiative, never, ask_first, mimo_key. Writes persona, soul, memory, gates, provider config.
- Ask Elitza chat: WebSocket endpoint /ws/chat in crmview.ts, wired to Elitza engine via ctx (session create/prompt/context). Standalone fallback to direct MiMo call (token-plan endpoint) with SOUL.md as system prompt + CRM tool-calling loop (search/get/update clients, deals, tags, notes, cost). Chat panel in HTML with animated typing indicator and avatar.
- Fixed nav highlight bug: showView now highlights the exact clicked nav item (passed via `this`) instead of a hardcoded index map.

### Modified
- crm.ts: schema + migration for new tables/columns; audit logging in updateClient.
- outreach.ts: writeDraft variant support; renderDraft variant frontmatter; variantStats.
- memory.ts: Darwin gate in storeProcedural.
- index.ts: cost tracking in finalize.
- tools.ts: new actions/cases.

## 2026-10-31 — Tier 1 batch: capability tokens, backups, tests

### Added
- `packages/plugins/elitza-brain/src/capability.ts` — UCAN-inspired capability tokens: mint, verify, delegate (subset + expiry), revoke, covers, session attach/detach. Signed with Elitza's Ed25519 identity. Persisted issued/revoked/session maps under `~/.ai-enablement-agent`.
- `packages/plugins/elitza-brain/src/capability.test.ts` — 10 tests.
- `backup` tool (tools.ts) — tar.gz of `~/.ai-enablement-agent`, list/create.
- Permission enforcement hook in `index.ts` — if a session has an attached capability token, it overrides the static ruleset (allow only if valid + covering).
- `capability` tool (tools.ts) — mint/verify/delegate/revoke/list/revoked/attach/detach/session.
- Tests: `verticals.test.ts`, `templates.test.ts`, `handover.test.ts` (20 tests total this batch).
- Heartbeat: records `heartbeat_last_tick` / `heartbeat_last_error` in soul for doctor visibility.
- Permission audit log: `~/.ai-enablement-agent/permission-decisions.jsonl` append-only log of every evaluated decision (source: ruleset/capability).

### Modified
- `index.ts` — permission.evaluate hook for capability enforcement + decision logging; imports.
- `heartbeat.ts` — last tick/error tracking.

### Notes
- Capability tokens are opt-in: attach via `capability attach <session_id> <token>`. Auto-minting on subagent spawn is a follow-up.

## 2026-10-31 — Feature batch: verticals, templates, triggers, CRM v2, signed handovers

### Added
- `packages/plugins/elitza-brain/src/identity.ts` — Ed25519 keypair under `~/.ai-enablement-agent/identity.pem` + `identity.pub`; sign/verify/sha256.
- `packages/plugins/elitza-brain/src/verticals.ts` + `vertical` tool — industry packs (farming, trades), seed/list/show/use, active vertical injected into system prompt.
- `packages/plugins/elitza-brain/src/templates.ts` + `template` tool — automation template registry (lead-capture-webhook, review-request-sequence, invoice-reminder), instantiate per client with placeholder substitution, CRM asset registration.
- `email_triggers` table in crm.db + `trigger` tool + heartbeat pass — event-driven touches (stage_is, days_in_stage, days_after_handover), drafts for approval, cooldowns.
- CRM house API: `/api/bulk/status`, `/api/today`.
- Signed handovers: `generateHandover` now signs body + writes sidecar `.sig`; `verifyHandover`; handover tool gains `action: generate|verify` and `file`.

### Modified
- `handover.ts` — HandoverResult gained signed/public_key/signature_path/sha256; signature block appended.
- `tools.ts` — new tools: vertical, template, trigger, backup, capability, handover verify.
- `heartbeat.ts` — trigger pass (gated by ELITZA_TRIGGERS).
- `crm.ts` — email_triggers table + functions; AI_ENABLEMENT_HOME import.
- `crmview.ts` — bulk/today endpoints.
- `index.ts` — seed verticals/templates; inject active vertical; permission hook.

### Removed
- Nothing removed.

## 2026-10-31 — Scout: gitlawb/Twigpine

### Notes
- Scouted gitlawb (now Twigpine): decentralized signed git, UCAN delegation, iCaptcha, OpenGateway, Darwin method, issues/PRs as git refs, trust scores. Full report delivered in conversation.

## Earlier (pre-tracking)
- Elitza fork of opencode; brain plugin (memory, emotion, learning, CRM, outreach, production, handover, tasks, heartbeat, CRM house). See git history / CHANGELOG.md for details.
EOF
echo done