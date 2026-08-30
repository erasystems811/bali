# Bali — WhatsApp Bot Build Status

Source of truth for this business's bot. **Read this before every task.**

## Before trusting anything below

This file only stays accurate if every session updates it before finishing.
Quickly check the "What's actually built" section against the real code
(`n8n/_src/*.js`) and the live server (`167.233.242.179`) before relying on
it — if what you find doesn't match what's written here, trust the code,
then fix this file.

## What this business needs

Bali is an event hospitality venue. The bot (`n8n/_src/stage1-code.js` and
related files) handles the full sales/onboarding flow: greeting, intake
(date, name, event type/name, returning-client check, IG/TikTok/website
reference), PM handoff with a structured summary, contract, invoicing, and
payment confirmation. Full spec: `docs/bali-sales-onboarding-spec.md`.

## What's actually built (verify against the code, don't just read this)

- [x] Full sales intake flow, live and working (`stage1-code.js`)
- [x] PM handoff with structured chat summary (`notifyPmOfCompletedIntake`)
- [x] Contract/invoice/payment flow (`99-stage3-4-invoice-contract.json`)
- [x] Sandbox environment for safe testing before anything goes live
- [x] `client_reference` (IG/TikTok/website) now correctly accepts "I don't
      have one" in any phrasing, instead of blocking intake forever
      (fixed 2026-08-04, see git log)
- [ ] **Not yet done**: migrated onto the shared `bot-engine` toolkit (see
      `../era-dash-os/bot-engine/`) — Bali predates that toolkit, so its
      code is still hand-rolled rather than built on the shared building
      blocks. Migrate one isolated piece at a time (e.g. swipe-reply
      routing first), never the whole file at once — see
      `../era-dash-os/FIX-PROTOCOL.md`.
- [x] **`01-inbound-router.json` now also routes Chidera's own number to
      ERA's WhatsApp fix-bot** (`../era-dash-os/fixbot/`) when her message
      starts with "fix" or a fix-bot conversation is already active — new
      "Check If Ops Message" → "Is Ops Message?" → "Forward to Ops
      Assistant" branch, inserted before "Lookup Contact". Every other
      sender, and every other message from her own number, is completely
      unaffected (verified by reading the deployed workflow's node/
      connection JSON, not live-tested against real traffic — see
      project_whatsapp_fix_bot memory for why). Needs `FIXBOT_WEBHOOK_TOKEN`
      and `FIXBOT_URL` env vars on the `n8n` container (added to
      `docker-compose.yml` + `.env` 2026-08-30) to actually reach fixbot at
      `http://172.18.0.1:4200` (the docker bridge gateway — n8n has no
      `host.docker.internal` entry configured). ufw rule added: port 4200
      allowed from `172.18.0.0/16` only.

## Stack

Self-hosted on Hetzner (`167.233.242.179`, `bali.erasystems.com.ng`):
n8n (bot logic), Postgres (own database), PostgREST, Gotenberg (PDFs),
Caddy. See `README.md` for the full setup.

## Last updated

2026-08-30 — added the fix-bot inbound routing branch to
`01-inbound-router.json` (see above), deployed live via
`scripts/production-sync-now.mjs`, confirmed active with 16 nodes via the
n8n API. Not yet verified against a real WhatsApp message.

## Standing instruction for every session

**Before you stop working**, update "What's actually built" and "Last
updated" above to reflect exactly what you did — not what you planned. The
next session working on Bali's bot may be a completely fresh Claude
session with no memory of this one, and will rely on this being accurate,
not aspirational.
