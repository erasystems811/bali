-- v6 (2026-11-23): reminders before each reservation. Idempotent.
alter table reservation_settings add column if not exists reminder_hours int not null default 6;   -- 0 = off
alter table reservations add column if not exists reminder_sent_at timestamptz;
alter table reservations add column if not exists reminder_tries int not null default 0;
