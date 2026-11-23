-- v7 (2026-11-23): short chat links + a tidier welcome message. Idempotent.
alter table web_sessions add column if not exists short_code text;
update web_sessions set short_code = substr(md5(token || random()::text), 1, 12) where short_code is null;
create unique index if not exists web_sessions_short_idx on web_sessions (short_code);
alter table reservation_settings alter column welcome_text set default E'*Hey, welcome to Bali!* 👋\n\nTap the button below to make your table reservation.';
update reservation_settings set welcome_text = E'*Hey, welcome to Bali!* 👋\n\nTap the button below to make your table reservation.' where welcome_text like 'HEY, WELCOME TO BALI%';
