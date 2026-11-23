# Bali — WhatsApp Bot Build Status

Source of truth for this business's bot. **Read this before every task.**

## Before trusting anything below

This file only stays accurate if every session updates it before finishing.
Quickly check the "What's actually built" section against the real code
(`n8n/_src/*.js`) and the live server (`167.233.242.179`) before relying on
it — if what you find doesn't match what's written here, trust the code,
then fix this file.

## What this business needs

Bali is a venue with many vendors. Guests reserve TABLES. Standalone Node app in `app/` (no n8n); see `ops/README.md` for the full picture. Flow: WhatsApp message (Bali picture + TABLE RESERVATION button + enquiries link) -> NATIVE WhatsApp form (a published Flow, ID in reservation_settings.flow_id, definition in app/lib/flow.js, publish with scripts/publish-flow.js; dates/times/closed days are sent live with every message; website form /reserve is only the fallback when flow_id is empty) with name, phone, date, arrival time, guests -> Paystack N20,500 (N20,000 credited to the order + N500 fee, refund of N20,000 if cancelled 24h+ ahead) -> details sent to the HANDOVER number + stored -> order link baliabuja.mylo.africa. Enquiry chat answers only from the knowledge_base table. Dashboard tabs: Reservations (graphs), Chats, Knowledge base, Settings.

## What is built (2026-11-23)

- [x] App deployed, 70+ end to end checks pass (app/test/app.test.js)
- [x] Bali number webhook -> https://bali.77-42-122-241.sslip.io/webhook/whatsapp?k=<BALI_FORWARD_SECRET>
- [ ] PAYSTACK_SECRET_KEY not set; payments_enabled is OFF in reservation_settings until it is (then switch it on in Settings and add the key to /opt/bali/.env, docker compose up -d app)
- [ ] Handover number not set yet (Settings tab); needs one WhatsApp reply of "okay" to the bot number to release queued messages outside 24h
- [ ] DNS A records bali. (and set APP_BASE_URL + number webhook to the real domain)
- [ ] Real WhatsApp end to end test not done yet
- [ ] OpenAI not used (old key invalid); enquiry matching is deterministic over the KB. Optional: OPENAI_API_KEY_WORKING in .env enables a KB-only LLM fallback.
- Retired: n8n workflows, PostgREST, Gotenberg, old event/contract/invoice flow (see git history).

## Stack

Self-hosted on the shared Hetzner host 77.42.122.241 (/opt/bali), 2 containers. Rebuilt 2026-11-22 after the old box died; fresh DB.

## Last updated

2026-11-23 - standalone reservations app live; see list above.

## Standing instruction for every session

**Before you stop working**, update "What's actually built" and "Last
updated" above to reflect exactly what you did — not what you planned. The
next session working on Bali's bot may be a completely fresh Claude
session with no memory of this one, and will rely on this being accurate,
not aspirational.
