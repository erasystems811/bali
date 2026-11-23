-- v12 (2026-11-23): the guest confirmation message can wait until they finish the WhatsApp form. Idempotent.
alter table reservations add column if not exists confirm_msg_status text;   -- null | pending | sent
alter table reservations add column if not exists confirm_due_at timestamptz;
