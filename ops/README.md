# Bali server setup (rebuilt 2026-11-22 after the old Hetzner box became unreachable)

Lives on the shared Hetzner host `77.42.122.241` in `/opt/bali`. Secrets are in `/opt/bali/.env` ON THE SERVER ONLY (never in git):
DB_PASSWORD, JWT_SECRET, SERVICE_KEY (HS256 JWT, role bali_service, signed with JWT_SECRET), N8N_ENCRYPTION_KEY, SESSION_SECRET,
plus OPENAI_API_KEY, META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_WEBHOOK_VERIFY_TOKEN, BALI_FORWARD_SECRET (copy from local .env).

Rebuild from scratch:
1. Copy `ops/docker-compose.yml`, `dashboard/`, `supabase/schema.sql`, `ops/post-schema.sql` to `/opt/bali`; create `.env`.
2. `docker compose up -d postgres`; `CREATE DATABASE bali;`; apply `schema.sql` to `bali`; apply `post-schema.sql` with `-v dbpass=$DB_PASSWORD`.
3. `docker compose up -d --build`; add `ops/caddy-block.txt` to the shared Caddyfile; validate + reload.
4. n8n: create owner (`POST /rest/owner/setup`), create an API key, import `n8n/0[1-6]*.json` and `99*.json`, activate each.
5. DNS: A records `n8n` and `bali` (erasystems.com.ng) -> server IP. Then set the WhatsApp number's webhook override to
   `https://n8n.erasystems.com.ng/webhook/whatsapp-inbound` (verify token = META_WEBHOOK_VERIFY_TOKEN).
6. Add a dashboard login: insert into `dashboard_users` (bcryptjs hash).

NOTE: the old live data (contacts, knowledge base, bookings, conversations) was lost with the old server; this was a fresh start.
`FIXBOT_URL`/`FIXBOT_WEBHOOK_TOKEN` are NOT set on this n8n (fix-bot branch inactive).
