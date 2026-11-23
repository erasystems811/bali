# Bali — WhatsApp Bot Build Status

Source of truth for this business's bot. **Read this before every task.**

## Before trusting anything below

This file only stays accurate if every session updates it before finishing.
Quickly check the "What's actually built" section against the real code
(`n8n/_src/*.js`) and the live server (`167.233.242.179`) before relying on
it — if what you find doesn't match what's written here, trust the code,
then fix this file.

## What this business needs

Bali is a venue with many vendors on site. Guests book TABLES over WhatsApp (scope changed from event booking on 2026-11-23). The bot (`n8n/_src/reservation-code.js`, workflow "02 Table Reservations") asks for day, time, number of guests and name, confirms instantly if there is room (capacity per time slot is configurable), and tells staff. Guests can change, cancel (YES to confirm) and ask their booking status; questions are answered from the knowledge_base + opening hours, otherwise escalated to staff. Staff (roles pm, floor_manager, staff, supervisor, facility_manager) use plain commands: today, tomorrow, list <day>, cancel R-xxxx [reason], move R-xxxx to <when>, guests R-xxxx n, tell <number> <message>, lookup <number>. Staff free text is NEVER relayed to guests. Settings live in table reservation_settings (hours, slot size, capacity, max party, closed weekdays). No payment/deposit.

## What is built (2026-11-23)

- [x] Reservation flow + staff commands, tested: `node tests/reservation.test.mjs` (fake DB/WhatsApp, real OpenAI if the key works, rule based fallback reader if not)
- [x] Deployed to the live n8n; router (01) forwards customer AND all staff-like roles to /webhook/reservations
- [x] Old event/contract/invoice workflows (02 stage1, 03, 04, 05, 99) deactivated in n8n and removed from the repo (see git history). Their _src files remain for reference; rebuild only with BUILD_LEGACY=1.
- [ ] Dashboard has NO reservations/settings tabs yet (edit reservation_settings via SQL for now)
- [ ] OpenAI key in .env is INVALID (401) as of 2026-11-23: the bot runs on the rule based reader until a working key is set in /opt/bali/.env and docker compose up -d n8n
- [ ] No staff contacts yet in the new DB: add role pm / floor_manager contacts or nobody gets notified
- [ ] DNS for n8n./bali.erasystems.com.ng; the live webhook currently uses n8n.77-42-122-241.sslip.io (compose rewritten on the server; real-domain version kept as docker-compose.yml.real-domains)

## Stack

Self-hosted on the shared Hetzner host `77.42.122.241` in `/opt/bali` (rebuilt 2026-11-22 after the old box 167.233.242.179 became unreachable; old data lost, fresh DB). n8n + Postgres + PostgREST + Gotenberg + dashboard in docker compose, routed by the shared Caddy. Full rebuild recipe: `ops/README.md`. Domains: n8n.erasystems.com.ng, bali.erasystems.com.ng (need DNS A records -> 77.42.122.241; the DirectAdmin API key is locked to the old server IP so DNS is manual).

## Last updated

2026-11-23 - pivoted Bali to table reservations, deployed live, synthetic end to end check passed (booking created, reply logged, test rows removed). Bali number +234 814 049 0247 webhook points at n8n.77-42-122-241.sslip.io/webhook/whatsapp-inbound?k=<BALI_FORWARD_SECRET>. Not yet confirmed with a real WhatsApp message after the pivot.

## Standing instruction for every session

**Before you stop working**, update "What's actually built" and "Last
updated" above to reflect exactly what you did — not what you planned. The
next session working on Bali's bot may be a completely fresh Claude
session with no memory of this one, and will rely on this being accurate,
not aspirational.
