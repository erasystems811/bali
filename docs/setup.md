# Bali — Setup & Current State

## What's live right now

- **Supabase project "BALI"** (`hyoaqjjotyxokqajflhl`, region eu-west-1) — schema applied and verified. All 10 tables exist: `contacts`, `bookings`, `conversations`, `knowledge_base`, `ingredients`, `recipes`, `recipe_ingredients`, `stock`, `sops`, `pending_questions`.
- Credentials live in `.env` at the project root (gitignored — never commit this file). `supabase/apply-schema.mjs` is re-runnable any time the schema changes (`node supabase/apply-schema.mjs`).

## What's built but not deployed

The `n8n/*.json` files are ready to import into an n8n instance, but **no n8n instance exists yet** — pick a host (Railway/a VPS/Docker locally) and self-host it, per the spec.

| File | What it does |
|---|---|
| `01-inbound-router.json` | Meta webhook verification + inbound message routing by role (Section 9a) |
| `02-stage1-sales-flow.json` | Bot-led intake: date → availability → event name → event type → new/existing client |
| `03-pm-toggle.json` | "open [event]" / "close" commands, message relay, pending-question resolution + reply-to disambiguation |
| `04-kb-check.json` | Off-script question handling: KB lookup via OpenAI, PM escalation, opt-in KB save |
| `05-stage5-fanout.json` | Runs every 5 min: fans out department briefs for `status = 'signed'` bookings, sends day-of checklists |
| `99-stage3-4-invoice-contract.json` | **Partial stub** — only the 24h lawyer nudge is built; invoice drafting and contract field extraction are blocked on real invoice/contract samples (see Open Items below) |

Each workflow's logic lives in `n8n/_src/*.js` (plain JS, easier to review/edit) and gets compiled into the importable JSON via `node n8n/_src/build.mjs` — re-run that after editing any `_src/*.js` file, don't hand-edit the `.json` files directly.

**Important:** these were authored without a live n8n instance to test against. Before going live, import each file into the n8n editor, check every node imports cleanly, and test-run one workflow at a time — particularly the Webhook and Schedule Trigger nodes, whose exact parameter shape can shift between n8n versions.

## Still needs provisioning (your call)

1. ~~n8n hosting~~ — **done.** Deployed on Railway, project "bali": https://n8n-production-0c86.up.railway.app. `N8N_BASE_URL` is set both in `.env` and as a Railway variable on the `n8n` service. Its own `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are already set as Railway variables too.

   **First-time setup (you have to do this part yourself — it's your login):**
   - Visit https://n8n-production-0c86.up.railway.app
   - It'll ask you to create an owner account (name, email, password) — that's just your login for the n8n editor, nothing to do with WhatsApp/Supabase.
   - Once in, go to **Workflows → Import from File** and import each of the 6 files in `n8n/` (the `.json` ones, not the `_src` folder) one at a time.
   - Each workflow needs to be turned **Active** (toggle top-right) once you're ready for it to run for real.

2. **`OPENAI_API_KEY`** — paste it to me and I'll set it on the Railway `n8n` service directly, same as the Supabase keys. (Or set it yourself: n8n → your workflow → the env var is read via `$env.OPENAI_API_KEY`, so it just needs to exist as a Railway variable on the `n8n` service.)
3. **WhatsApp Cloud API** — register the dedicated Bali number under your Meta Business Manager, direct (not a BSP). You'll get `META_ACCESS_TOKEN` and `META_PHONE_NUMBER_ID` — send those to me the same way and I'll wire them up. A verify token is already generated (`META_WEBHOOK_VERIFY_TOKEN` in `.env` and on Railway) — when you register the webhook callback URL in the Meta app dashboard, use `https://n8n-production-0c86.up.railway.app/webhook/whatsapp-inbound` as the URL and paste that same verify token into Meta's "Verify Token" field.
4. **Retool** — free tier, for admin visibility/editing over the Supabase tables. Not built yet; connect Retool directly to the Supabase project once you're ready (Retool has a native Supabase/Postgres connector — point it at the same `DATABASE_URL`).

## Before launch (from the spec)

- Populate `contacts` with every staff member's phone number + role before going live (Section 9a) — unrecognized numbers default to the customer flow.
- Populate `knowledge_base` with your real FAQ content.
- `recipes` / `ingredients` / `stock` are schema-only — no reconciliation logic is built yet (deferred, per Section 7 of the spec).

## Open items blocking full build-out

- **Invoice/contract field extraction** (spec Section 10) — send real invoice and contract examples; without them, Stage 3 (invoice drafting) and most of Stage 4 (lawyer kickoff → PM approval → send to client) can't be built. The parts of Stage 4 that don't need the samples — signature detection and PM confirmation — are already wired into `02-stage1-sales-flow.json` and `03-pm-toggle.json`, ready to activate once the rest exists.
- Stage 5 fan-out (`05-stage5-fanout.json`) sends real briefs to HR/Procurement/Accounts/Event Assistant/Security/Supervisor/Facility Manager — but none of those contacts exist in `contacts` yet, so it's a no-op until they're added.
