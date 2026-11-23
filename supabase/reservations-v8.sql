-- v8 (2026-11-23): polite welcome line. Idempotent.
alter table reservation_settings alter column welcome_text set default E'*Hey, welcome to Bali!* 👋\n\nPlease tap the button below to make your table reservation.';
update reservation_settings set welcome_text = E'*Hey, welcome to Bali!* 👋\n\nPlease tap the button below to make your table reservation.' where welcome_text like E'%\n\nTap the button below to make your table reservation.';
