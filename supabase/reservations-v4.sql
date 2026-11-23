-- v4 (2026-11-23): native WhatsApp form (Flow). Idempotent.
alter table reservation_settings add column if not exists flow_id text;
