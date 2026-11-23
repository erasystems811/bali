-- v10 (2026-11-23): guests can change their own reservation until this many hours before arrival (0 = any time). Idempotent.
alter table reservation_settings add column if not exists change_cutoff_hours int not null default 3;
alter table reservation_settings add column if not exists notify_changes boolean not null default true; -- tell the handover number when a guest changes or cancels
