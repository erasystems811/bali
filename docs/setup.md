# Bali — Setup & Current State

## What's live right now

- **Supabase project "BALI"** (`hyoaqjjotyxokqajflhl`, region eu-west-1) — schema applied and verified. 12 tables: `contacts`, `bookings`, `conversations`, `knowledge_base`, `ingredients`, `recipes`, `recipe_ingredients`, `stock`, `sops`, `pending_questions`, `invoices`, `contracts`.
- **n8n**, self-hosted on Railway (project "bali"): https://n8n-production-0c86.up.railway.app — all 6 workflows imported and up to date via the n8n API. `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `N8N_BASE_URL`, `OPENAI_API_KEY`, `META_WEBHOOK_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID`, and `GOTENBERG_URL` are all set as Railway variables on the `n8n` service. `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is also set — without it, every Code node's `$env.*` reads (Supabase/OpenAI/Meta credentials) silently throw and every workflow breaks. If a future n8n upgrade ever resets Railway variables, check this first.
- **`bali-pdf`**, a self-hosted Gotenberg service (Docker image `gotenberg/gotenberg:8`) in the same Railway project, private-network only (`bali-pdf.railway.internal:3000`, no public domain). Renders the styled invoice HTML (`formatInvoiceHtml` in `stage3-4-action-code.js`) to a real PDF matching the actual `BALI-2026-003` template — logo, dark table header, red WHT line, twin payment-info/terms boxes. No API key, no per-document cost, no client data leaving Railway.
- **All 7 workflows are active** (01 inbound router, 02 sales flow, 03 PM toggle, 04 KB check, 05 fan-out, 06 privacy policy, 99 invoice/contract).
- **Shared Meta app with Nexa.** Bali's WhatsApp number was added as a second number on Nexa's existing Meta app/WABA, not a new app of its own — same access token, and critically, only ONE webhook callback URL is allowed per app. That URL is registered on **Nexa's** endpoint (`nexa/src/app/api/webhooks/whatsapp/route.ts`, already live before Bali existed), not Bali's. Nexa's route now inspects `metadata.phone_number_id` on every incoming message: if it's Bali's number (`1254157744444881`), it forwards the raw message payload untouched to Bali's n8n webhook (`.../webhook/whatsapp-inbound`) and never runs any Nexa logic on it — full isolation, separate Supabase projects, separate conversation state, nothing shared but the pipe. Nexa's own `whatsappMediatedChat` feature flag does NOT gate this forwarding (checked per-message, after the Bali branch, not before it) — if it didn't, toggling Nexa's flag off would silently kill Bali's bot too.
  - Auth: since Bali's `/webhook/whatsapp-inbound` is no longer called by Meta directly (Nexa is the sole registered endpoint now), it's authenticated instead by a shared secret (`BALI_FORWARD_SECRET`, set on both Nexa's and Bali's Railway services) sent as the `x-bali-forward-secret` header. `Parse Inbound Message` in `01-inbound-router.json` checks this first and silently drops anything that doesn't match — there's no HTTP response left to reject with by that point, since this endpoint's `responseMode` is `onReceived` (n8n already returned 200 before this code runs).
  - Bali's own `META_WEBHOOK_VERIFY_TOKEN` / GET-verify handshake is now vestigial — Meta already completed that dance against Nexa's endpoint, not Bali's. Harmless to leave in place.
  - **Verified working end-to-end 2026-07-24**, after fixing two real bugs found during testing:
    1. The Nexa-side relay code was written and typechecked but never actually deployed (sat as uncommitted local changes) — the live Nexa server was running old code with zero knowledge of Bali, so it really was processing Bali's messages as if they were Nexa's own. Committed + pushed (`a132d2a`) to trigger a real Railway deploy.
    2. `01-inbound-router.json`'s "Lookup Contact" node (queries Supabase for the sender) returns zero rows for any brand-new customer — and n8n's default behavior is to silently stop the workflow entirely when a node outputs zero items, rather than continue with "no contact found." This meant **every new customer's first message would die silently and never reach the sales flow** — a pre-existing bug, not something introduced this session. Fixed by setting `alwaysOutputData: true` on that node, which makes n8n pass through an empty object instead of stopping.
    - After both fixes, a real signed test message through Nexa's actual live endpoint correctly created a contact, started a booking, and generated the greeting reply, confirmed via Supabase.
- **Privacy policy page**, served directly from n8n (no separate website needed): `https://n8n-production-0c86.up.railway.app/webhook/privacy-policy`. This is what to give Meta's App Dashboard when it asks for a Privacy Policy URL during WhatsApp product setup. Static page (`06-privacy-policy.json`, plain webhook + respond-to-webhook node, no `_src` file since there's no logic — just edit the HTML and re-PUT the workflow to update). Currently serves the standard **ERA Systems LTD** privacy policy (per `era-systems-privacy-policy.md`) rather than a Bali-specific one, since Bali is a client Service operated by ERA and this is ERA's umbrella policy covering all such Services. If ERA ever stands up erasystems.com.ng with its own hosted copy, that'd be the more correct long-term canonical location — this n8n-hosted copy is a fine stand-in until then.
- Credentials live in `.env` at the project root (gitignored — never commit this file). `supabase/apply-schema.mjs` is re-runnable any time `schema.sql` changes.
- **Meta webhook callback URL:** `https://n8n-production-0c86.up.railway.app/webhook/whatsapp-inbound`. **Verify token:** value of `META_WEBHOOK_VERIFY_TOKEN` in `.env`.

## Workflows (all built, none stubbed anymore)

| File | What it does |
|---|---|
| `01-inbound-router.json` | Meta webhook verification + inbound message routing by role: customer → Stage 1, PM → PM Toggle, lawyer → Stage 3-4, anyone else → logged only (Section 9a) |
| `02-stage1-sales-flow.json` | Bot-led intake (date → availability → event name → event type → new/existing client), **plus** proof-of-payment forwarding while `invoiced`, **plus** collecting the organizer's legal name/address from the client while `awaiting_contract` |
| `03-pm-toggle.json` | "open \[event]" / "close" / "invoice \[event]" commands, message relay, pending-question resolution + reply-to disambiguation, delegates invoice/contract/payment approvals to Stage 3-4 |
| `04-kb-check.json` | Off-script question handling: KB lookup via OpenAI, PM escalation, opt-in KB save |
| `05-stage5-fanout.json` | Runs every 5 min: fans out department briefs for `status = 'signed'` bookings, sends day-of checklists |
| `99-stage3-4-invoice-contract.json` | **Two independent triggers:** an hourly lawyer 24h-nudge, and a webhook handling invoice drafting/correction, payment confirmation, sending contract details to the lawyer, the lawyer's draft coming back, and contract approval/correction |

Each workflow's logic lives in `n8n/_src/*.js` (plain JS, easier to review/edit) and gets compiled into the importable JSON via `node n8n/_src/build.mjs` — re-run that after editing any `_src/*.js` file, then re-push via the n8n API (see below), don't hand-edit the `.json` files or re-import through the UI (Import from File merges nodes into whatever workflow is currently open in the browser — that's how the first import went sideways).

**Re-deploying after an edit:**
```bash
node n8n/_src/build.mjs
# then PUT the changed file(s) to https://n8n-production-0c86.up.railway.app/api/v1/workflows/{id}
# using the N8N_API_KEY in .env -- ask me to do this, I have the workflow IDs.
```

**Important:** these were authored without ever running them end-to-end against real WhatsApp traffic. Before going live, test each flow with a real message and watch the `conversations`/`pending_questions` tables in Supabase to confirm it's behaving as expected.

## Stage 1 — Intake conversation (redesigned 2026-07-25, after live testing)

Real-world testing by the owner surfaced that the original Stage 1 was a rigid slot-filling script (one canned line per field, no memory of the conversation) — it repeated itself verbatim, couldn't parse "friday next week" correctly, never asked "have you booked with us before," and had no voice-note support. Rebuilt `stage1-code.js`'s mid-intake handling as a genuine context-aware conversation:

- **Two-pass LLM design per turn**: pass 1 reads the *whole* conversation history (not just the latest message) and extracts every still-needed field the client's message provides, even several at once, even out of order. Pass 2 writes ONE fresh reply grounded in what actually happened (real DB-checked date result, the single next thing still missing) — never a fixed canned string, so revisiting the same field never sounds identical twice. Both passes explicitly instructed against "Awesome!"/exclamation-heavy tone — professional and warm, not bubbly.
- **Relative dates are resolved in code, not by the LLM.** Verified live: gpt-4o-mini resolved "friday next week" to a *Tuesday* even with today's date given as an anchor — LLM date arithmetic is not trustworthy. `resolveRelativeDate()` handles weekday names, "next X", "this/next weekend", "tomorrow", "in N days/weeks" with real Monday-anchored week-boundary math (the tricky part: "next Friday" said late in the week can already BE the nearest Friday, not nearest-Friday-plus-7).
- **Voice notes are now transcribed** (`transcribeVoiceNote`, Meta media download → OpenAI Whisper) before being fed through the same pipeline as text — the inbound router's `Parse Inbound Message` node now also recognizes `message.audio`, which it silently dropped before (voice notes were completely unhandled prior to this).
- **Fixed a real schema bug**: `bookings.is_existing_client` had `not null default false`, so the "still missing" check (`IS NULL`) could never see it as unanswered — the bot silently skipped ever asking "have you booked with us before?" on every single booking. Column is now nullable with no default (`ALTER TABLE` applied directly + `schema.sql` updated); in-progress bookings were reset to NULL.
- All customer-facing copy across every workflow (`stage1`, `pm-toggle`, `kb-check`, `stage5-fanout`) had its em dashes and double-hyphens removed — matches the spec's "never sound like an AI" tone rule; real humans rarely type "—" in a text conversation.
- **Off-topic-question repetition fixed**: `kb-check-code.js` used to send the identical "let me check on that" line and re-ping the PM every single time a customer repeated/re-asked while waiting — now varies the wording across 3 tiers by how many times it's come up for that booking, and only actually notifies the PM once per still-open matter (further repeats log a lightweight auto-resolved tally row instead of re-escalating).
- **"What dates are available?" no longer routes to KB/PM escalation** — there's no calendar-listing feature (checking is always per-specific-date), so this now turns back into a direct re-ask ("Just let me know the date you have in mind...") instead of pinging the PM with an unanswerable question every time.
- **Every HTTP call across all 6 workflow files now has an explicit timeout** (15-45s depending on the service). Found live: a single stalled outbound call (no timeout was set anywhere in the original codebase) hung an entire execution for the full 300-second n8n task-runner limit, silently dropping that turn's conversation log. This was a pre-existing gap across the whole codebase, not specific to Stage 1.
- Verified end-to-end multiple times via real signed webhook calls through Nexa's live relay: correct date math, single-question-at-a-time, multi-field extraction from one message ("birthday party for my sister" → both event_name AND event_type), correct `is_existing_client` capture, clean completion message, no dashes, no "Awesome!".

**Second round of owner feedback (2026-07-25), also implemented:**
- **`client_reference` (Instagram/TikTok/website) is now asked of every client**, not just returning ones — `fieldOrder()` always includes it now. Spec originally scoped this to existing clients only; owner wants it collected universally as useful context regardless.
- **Event type is asked open-ended** — the reply-generation prompt now explicitly forbids offering a multiple-choice list ("a birthday, a wedding, or something else"); just asks what kind of event it is and how Bali can help. In testing, the model often infers the type directly from the event name anyway (e.g. "Chidera Product Launch" → type "product launch" without a separate question).
- **Completion message to the customer changed**: no longer names "your events manager" — just "Give me a moment, I'll follow up with you shortly," keeping the bot itself as the consistent voice the customer is talking to.
- **The PM is now actually notified when intake completes** (`notifyPmOfCompletedIntake` in stage1-code.js) — this was a real gap, the PM previously had no way to know a booking was ready except checking Retool manually. Sends a summary (event name, date, type, new/returning + their social page) and the exact `open [event name]` command to take over directly.
- **The PM now sees the prior bot-customer conversation when they type "open [event name]"** — `pm-toggle-code.js` forwards the full transcript before confirming the handoff, so the PM isn't starting blind. This also wasn't built before (owner asked directly: "can PM see past personal messages between bot and customer?" — answer was no, now yes).
- **Verified live with owner's go-ahead** (sent Joseph one real test notification): this surfaced two more critical, previously-invisible bugs.
  1. `01-inbound-router.json`'s "Determine Role" node checked `Array.isArray()` on the "Lookup Contact" HTTP node's output — but that node returns one item per matched row directly (not a wrapped array), so the check always failed and **every single sender, regardless of actual role, was always treated as `customer`** — PM and lawyer routing had never worked, not once, since this workflow was first built. Fixed by checking for a real contact record directly (`contactItem.id`) instead of an array wrapper.
  2. Separately, `stage1-code.js`'s contact upsert unconditionally set `role: 'customer'` on every message via `on_conflict=phone_number` + merge-duplicates — meaning if a PM/lawyer/staff contact's message ever got misrouted to Stage 1 (exactly what bug #1 caused), their role would get silently overwritten back to `customer` in the database. Fixed: Stage 1 now only ever creates a brand-new contact as `customer`; it never touches an existing contact's role.
  - These two bugs compounded each other during testing: fixing Joseph's role via Retool, then having an in-flight misrouted message silently reset it back, made the bug look like it "wouldn't stick" before the actual root causes were found.
  - Confirmed fixed end-to-end: a real signed message from Joseph's number with `"open Corporate Event"` correctly routed to PM Toggle, and the booking's `mode` flipped to `pm-led` as expected.

## Stage 3 — Invoice (now real, not a stub)

- Triggered when the PM types **"close"** on a `negotiating` booking (price agreed → drafts automatically), or manually via **"invoice \[event name]"**.
- Line items + payment terms are extracted from the logged negotiation via OpenAI; VAT (7.5%) / WHT (2%) / total are always bot-calculated, matching the real invoice sample (`BALI-2026-003`): `total = subtotal + subtotal×0.075 − subtotal×0.02`.
- Invoice numbers auto-increment per year: `BALI-{year}-{seq}`.
- Sent to the PM for approval first — **reply "yes"** sends it to the client, **reply with anything else** is treated as a correction and the invoice is regenerated and re-sent for approval (Section 3a).
- Client proof of payment gets forwarded to the PM to confirm; confirming moves the booking to `awaiting_contract` and asks the client for their organization's legal name + registered address.

## Stage 4 — Contract (now real, not a stub)

- Once the client confirms their legal name + address, the bot sends the five variable fields (organizer, event name/date/type, fee, payment split) to the lawyer — the bot never drafts contract language itself.
- Lawyer sends back a PDF → the actual PDF (not just a text notice) is forwarded to the PM for approval, same yes/correction pattern as the invoice (correction goes back to the lawyer, not regenerated by the bot).
- PM approval forwards that same PDF on to the client. Client signs and sends back a PDF → PM confirms validity → booking marked `signed`, which is what Stage 5's fan-out picks up.
- The 24h lawyer nudge (`99-stage3-4-invoice-contract.json`'s schedule trigger) fires automatically while a booking sits in `awaiting_contract` with the draft not yet received.
- Implementation note: the PM/client forwards reuse the lawyer's original WhatsApp media id directly (no download/re-upload) — standard for Cloud API, but only reliable while that media hasn't expired on Meta's side, so this should stay a same-day handoff in practice.

## Admin visibility (Retool) — now built

Live dashboard: **https://erasystems--bali-dashboard.retool.app** — org `erasystems`, resource "Bali Database" (Supabase Postgres via the pooler, SSL on with Supabase's CA cert uploaded — plain `sslmode=require` failed with "self-signed certificate in certificate chain" until the CA cert was added). Tabs for all 8 tables (bookings, contacts, invoices, contracts, conversations, pending_questions, knowledge_base, sops), built via Retool's AI app builder against the real schema. Retool's free-tier API tokens don't expose `resources`/`apps` scopes (only RPC/Custom Component Libraries), so this had to be built via direct browser automation rather than the REST API — if it ever needs updating programmatically, that limitation is still there.

**Contacts, Knowledge Base, and SOPs are fully self-serve** (add/edit/delete), since those are pure admin-managed reference data. The other 5 tabs (bookings, invoices, contracts, conversations, pending_questions) stay view-only, since the bot's own workflow logic owns that data — hand-editing it there could desync it from what the bot thinks is happening.

- **Add Contact form**: name, phone number (plain digits + country code, no `+`/spaces — e.g. `2348012345678`, no dial-code picker), role (strict dropdown matching the DB's 12 allowed values — typing a role that isn't one of these gets rejected by the database's CHECK constraint, and even if saved wouldn't be recognized by `01-inbound-router.json`'s role-based routing), permission_level (plain text, defaults to "standard"), tags.
- Role convention: one department-head contact per specific role (`hr`, `facility_manager`, `security`, etc.) — everyone else that person manages just gets role `staff`. Multiple contacts CAN share the same role (e.g. several `staff` rows), just not the department-head roles by convention.
- Backend functions (`upsertContact`, `deleteContact`, `upsertKnowledgeBase`, `deleteKnowledgeBase`, `upsertSop`, `deleteSop`) were all reviewed line-by-line before publishing — all use parameterized queries (`$1`/`$2`/... placeholders), none string-interpolate values into SQL, so no injection risk.

## Still needs provisioning (your call)

1. **Meta business verification** — submitted, "In review" (Meta's queue, nothing to do but wait). Separately, "Access Verification" (Tech Provider status, required because ERA operates WhatsApp for a client) is blocked until business verification completes, deadline **22 September 2026** before API restrictions kick in. See developers.facebook.com/28170337689266268/access-verification/.
2. **Add real staff contacts** beyond the PM (Joseph Owolabi, already in) — lawyer, and eventually HR/Procurement/Accounts/Event Assistant/Security/Supervisor/Facility Manager, via the Retool dashboard's Contacts tab.
3. **Populate `knowledge_base`** with real FAQ content via the Retool dashboard.

## Before launch (from the spec)

- `recipes` / `ingredients` / `stock` are schema-only — no reconciliation logic is built yet (deferred, per Section 7 of the spec).
- There's a real, unresolved test conversation in the live `bookings`/`conversations` tables from the owner's own number (+234 903 263 7607) testing the pre-fix bot — left in place intentionally as evidence, currently stuck mid-intake on the old canned responses. Worth deciding whether to let them re-send a message to continue it now that fixes are live, or reset it.

## Known gaps / simplifications (v1)

- Invoices are now real styled PDFs (via the self-hosted `bali-pdf` Gotenberg service), matching the actual `BALI-2026-003` template. Contract PDFs are the lawyer's real file, forwarded as-is (bot never generates contract language).
- Stage 5 fan-out (`05-stage5-fanout.json`) sends real briefs to HR/Procurement/Accounts/Event Assistant/Security/Supervisor/Facility Manager — but none of those contacts exist in `contacts` yet, so it's a no-op until they're added.
- Only one PM and one lawyer contact are assumed (first match by role) — fine for v1's single-PM setup.
- None of this (webhook routing, invoice PDF generation, contract forwarding) has been tested against real WhatsApp traffic yet — Gotenberg's HTML→PDF rendering was verified directly, but the full n8n → Meta media upload → WhatsApp send chain still needs a live smoke test once `META_ACCESS_TOKEN` is in.
