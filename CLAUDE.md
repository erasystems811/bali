# Bali — WhatsApp Bot Build Status

Source of truth for this business's bot. **Read this before every task.**

## Before trusting anything below

This file only stays accurate if every session updates it before finishing.
Quickly check the "What's actually built" section against the real code
(`n8n/_src/*.js`) and the live server (`167.233.242.179`) before relying on
it — if what you find doesn't match what's written here, trust the code,
then fix this file.

## What this business needs

Bali is a venue with many vendors. Guests reserve TABLES over WhatsApp. Standalone Node app in `app/` (no n8n); runbook in `ops/README.md`.

Flow: guest texts the Bali number -> ONE WhatsApp message (Bali picture, "TAP HERE TO RESERVE" button, short enquiries link) -> NATIVE WhatsApp form (a published Flow; id in `reservation_settings.flow_id`; definition `app/lib/flow.js`; publish a NEW version with `scripts/publish-flow.js`, deprecate the old one) that runs everything inside WhatsApp: details (name, phone, date, arrival time list, guests) -> live availability -> PAY screen (Monnify checkout link via open_url) -> "I have paid" -> confirmed screen. Screens are answered by the encrypted endpoint `POST /flow/endpoint` (`app/lib/flowendpoint.js`, `flowcrypto.js`; private key `/opt/bali/keys/flow_private.pem`, public key registered on the number).

Rules learned the hard way (do not regress): never answer a form step with the SAME screen (endless spinner); to refuse a step answer `{screen: <current>, data:{error_message}}`; WhatsApp drops a payload key named `action` (use `step`); only forward routing in the Flow routing_model (RESERVE -> PAY -> WAIT -> DONE); the form must answer within ~8s (payment calls time out at 7s); Monnify links contain "|" and are sent percent-encoded.

Money: Monnify (sandbox keys now; live keys later). Guest pays N20,500 (N20,000 credited to the order + N500 service charge, shown only as a small note at the end of the pay screen). Refund of N20,000 if cancelled 24h+ ahead (guests via their reservation page; staff from the dashboard can refund in full). The table is confirmed the moment the provider says the payment is received (verified with Monnify by our own reference); the Monnify webhook (`/webhook/monnify`, must be added in the Monnify dashboard) is the safety net when the guest closes the form. Setting `confirm_via_webhook` (default off) makes the webhook the only trigger.

After payment: the return page (`/reserve/<token>/done`) sends the guest straight back to the WhatsApp chat and sends the confirmation message right then (once). Confirmation is a message with a TAP TO MANAGE button (reservation page: change date/time/guests, cancel). Details go to up to 2 HANDOVER numbers (Settings). Reminder before arrival (default 6h, template `bali_reservation_reminder`). Enquiry chat (/ask) answers only from the knowledge_base table (keyword match first, then Claude if ANTHROPIC_API_KEY is set, KB-only). Reservation numbers run R-001, R-002, ... Bali is open 24 hours; no capacity or party-size limit by default. Dashboard: Reservations (graphs), Chats, Knowledge base, Settings.

Meta messages cost money: do not add extra WhatsApp messages (the owner objected to a pay button message). Cancel/change by a guest sends them a confirmation; the form never sends extra messages while paying.

## What is built (2026-11-24)

- [x] App deployed on the shared Hetzner host 77.42.122.241 (/opt/bali), 2 containers (app + postgres); 100+ end to end checks (`app/test/app.test.js`, run against a throwaway DB, see ops/README.md)
- [x] WhatsApp webhook on the Bali number -> https://bali.77-42-122-241.sslip.io/webhook/whatsapp?k=<BALI_FORWARD_SECRET>
- [x] Monnify sandbox payments live (keys in /opt/bali/.env on the server only)
- [x] Claude answers enquiries from the KB (ANTHROPIC_API_KEY on the server)
- [ ] Monnify LIVE keys (current ones are MK_TEST sandbox; set MONNIFY_BASE_URL=https://api.monnify.com)
- [ ] Monnify webhook URL added in the Monnify dashboard (owner action)
- [ ] Handover number(s) not set yet (Settings tab); each must message the bot once so WhatsApp delivers plain text
- [ ] DNS A record bali.erasystems.com.ng -> 77.42.122.241 (temporary sslip.io hostname is a reliability risk); then change APP_BASE_URL, the number webhook, and re-create the reminder template with the new domain
- [ ] Reminder template approval pending on Meta (check status)
- Retired: n8n workflows, PostgREST, Gotenberg, old event/contract/invoice flow (see git history).

## Stack

Self-hosted on the shared Hetzner host 77.42.122.241 (/opt/bali), app + postgres containers behind the shared Caddy. Rebuilt 2026-11-22 after the old box died; fresh DB. RAM is tight on that host.

## Last updated

2026-11-24 - after payment the guest is redirected back to the chat with the confirmation already sent; see list above.

## Standing instruction for every session

**Before you stop working**, update "What's actually built" and "Last
updated" above to reflect exactly what you did — not what you planned. The
next session working on Bali's bot may be a completely fresh Claude
session with no memory of this one, and will rely on this being accurate,
not aspirational.
