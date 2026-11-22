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

Self-hosted on the shared Hetzner host `77.42.122.241` in `/opt/bali` (rebuilt 2026-11-22 after the old box 167.233.242.179 became unreachable; old data lost, fresh DB). n8n + Postgres + PostgREST + Gotenberg + dashboard in docker compose, routed by the shared Caddy. Full rebuild recipe: `ops/README.md`. Domains: n8n.erasystems.com.ng, bali.erasystems.com.ng (need DNS A records -> 77.42.122.241; the DirectAdmin API key is locked to the old server IP so DNS is manual).

## Last updated

2026-11-22 - rebuilt the whole stack on the new host, imported workflows 01-06 + 99, verified webhook GET handshake and PostgREST/dashboard locally. NOT yet done: DNS, switching the WhatsApp number webhook (currently overridden to the EBOS/era-demo endpoint), seeding contacts/knowledge base.

## Standing instruction for every session

**Before you stop working**, update "What's actually built" and "Last
updated" above to reflect exactly what you did — not what you planned. The
next session working on Bali's bot may be a completely fresh Claude
session with no memory of this one, and will rely on this being accurate,
not aspirational.
