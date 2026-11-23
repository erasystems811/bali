-- v14 (2026-11-23): a booking is only confirmed when the payment provider's webhook confirms the payment. Idempotent.
alter table reservation_settings add column if not exists confirm_via_webhook boolean not null default true;
