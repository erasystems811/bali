# Bali — Sales & Onboarding Bot

WhatsApp bot for Bali (event hospitality venue) handling client inquiries through contract signing and department handoff. First module of a general-purpose business operating system — the architecture is generic (role/permission tags, `type`/`department` columns) so it can expand beyond sales/onboarding later.

Full spec: see the owner's `bali-sales-onboarding-spec.md`. Current build status and setup steps: [`docs/setup.md`](docs/setup.md).

**Stack:** fully self-hosted on a DigitalOcean droplet (`bali-server`, 143.198.179.150, domain `bali.erasystems.com.ng`) — docker-compose stack of n8n (orchestration/bot logic), Postgres (own database, replacing Supabase), PostgREST (Supabase-API-compatible REST layer), Gotenberg (PDF rendering), Caddy (reverse proxy + automatic HTTPS) · a new self-hosted staff dashboard is replacing the old Retool admin UI (see `docs/setup.md` for status) · Meta WhatsApp Cloud API, direct · OpenAI API (conversation engine)

## Structure

```
supabase/
  schema.sql          -- full schema, source of truth
  apply-schema.mjs     -- re-runnable: applies schema.sql to DATABASE_URL in .env
n8n/
  _src/*.js            -- workflow logic, plain JS (edit these, not the .json files)
  _src/build.mjs        -- compiles _src/*.js into the importable workflow JSON files
  *.json                -- importable n8n workflow exports
docs/
  setup.md              -- current state, what's live, what's still needed
.env                    -- credentials (gitignored, never commit)
```

## Quick start

```bash
npm install                     # installs the `pg` driver used by apply-schema.mjs
node supabase/apply-schema.mjs  # re-apply schema after editing schema.sql
node n8n/_src/build.mjs         # rebuild workflow JSON after editing n8n/_src/*.js
```

See `docs/setup.md` for what's live, what's stubbed, and what still needs to be provisioned (n8n hosting, WhatsApp Cloud API, Retool).
