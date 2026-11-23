# Bali: how it runs (rebuilt 2026-11-23, standalone app, no n8n)

Host: shared Hetzner server 77.42.122.241, folder /opt/bali. Two containers: `postgres` + `app` (this repo's `app/`).
Caddy (shared, /opt/shared-caddy) routes bali.erasystems.com.ng + bali.77-42-122-241.sslip.io to 127.0.0.1:21102.

What the app does
- WhatsApp webhook `/webhook/whatsapp?k=<BALI_FORWARD_SECRET>`: any guest text gets ONE card (Bali picture, TABLE RESERVATION button -> /reserve/<token>, enquiries link in the text).
- /reserve/<token>: form (name, phone, date, arrival time, guests) -> Paystack (N20,500: N20,000 credited to the order + N500 fee) -> confirmation + order link -> details WhatsApp'd to the handover number and stored.
- /ask/<token>: enquiry chat, answers ONLY from the knowledge_base table (edited on the dashboard); unknown questions are stored + sent to the handover number.
- /my/<token>: guest change/cancel (refund of N20,000 if cancelled 24h+ ahead).
- /dashboard: Reservations (KPIs + graphs + list), Chats, Knowledge base, Settings (handover number, payments, hours, capacity, welcome).
- /webhook/paystack: re-verifies every event against Paystack before confirming (the body is never trusted).

Secrets: /opt/bali/.env on the server only (DB_PASSWORD, SESSION_SECRET, META_*, BALI_FORWARD_SECRET, PAYSTACK_SECRET_KEY, APP_BASE_URL).

Deploy: tar app/ + ops/docker-compose.yml to the server, `docker compose up -d --build app`.
Schema: supabase/schema.sql, reservations.sql, reservations-v2.sql, reservations-v3.sql (idempotent, apply in order).
Tests: app/test/app.test.js runs the real app against a throwaway Postgres DB with fake WhatsApp/Paystack:
  create DB bali_test, apply the schema files, then
  docker run --rm --network bali_default -v <dir>/app:/app -w /app -e DB_HOST=postgres -e DB_PASSWORD=... -e DB_NAME=bali_test node:20-alpine sh -c "npm i --omit=dev && node test/app.test.js"
Number webhook: Graph API POST /<phone_number_id> webhook_configuration.override_callback_uri (verify_token = META_WEBHOOK_VERIFY_TOKEN).
