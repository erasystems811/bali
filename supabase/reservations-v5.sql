-- v5 (2026-11-23): Bali is open 24 hours; guests type their arrival time. Idempotent.
alter table reservation_settings add column if not exists open_24_7 boolean not null default true;
