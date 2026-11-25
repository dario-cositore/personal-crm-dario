# personal-crm-dario

Personal CRM build (Elitza fork) used for Dario Cositore's AI enablement consulting practice.
Temporarily public so Google Carbon (and collaborators) can review the codebase and leave
feedback. Will be made private again once the build is finalized.

## What's in here

- `packages/plugins/elitza-brain/` - the CRM brain plugin: client records, scouting,
  enrichment, outreach cadence, pipeline stages, playbooks, templates, routing.
- `packages/` - supporting packages (ai, app, cli, core, server, tui, ui, etc.) inherited
  from the Elitza/opencode fork.
- `docs/` - guides and reference docs (CRM house, install, guided setup, handover).
- `script/`, `patches/`, `turbo.json` - build and tooling.

## Running locally

Runtime: Bun 1.4+. Install deps:

```bash
bun install
```

See `docs/guide/install.md` and `docs/guide/guided-setup.md` for setup.

## Secrets (not in this repo)

Local-only files that must never be committed:

- `.tower` - Tower API key (gitignored).
- `TOWER_WEBHOOK_TOKEN`, `TOWER_CALLBACK_SECRET` - read from environment/config, never hardcoded.
- `.env`, `.env.local`, and any `*.pem` / `*.key` files.

If you spot a secret in the tree, open an issue before anything else.

## Collaboration notes

- Branch: `main` only. Push to `main` to make changes visible.
- Repo is public only for this review window. Do not add customer data, real client PII,
  or production credentials.
- When the build is finalized, the repo goes back to private.

## License

See `LICENSE`.