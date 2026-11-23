-- v15 (2026-11-23): once the payment provider says the payment is received, the table is confirmed immediately (webhook-only is now opt-in). Idempotent.
alter table reservation_settings alter column confirm_via_webhook set default false;
update reservation_settings set confirm_via_webhook = false where id = 1;
