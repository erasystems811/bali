-- v11 (2026-11-23): an optional second handover number. Idempotent.
alter table reservation_settings add column if not exists handover_number_2 text;
