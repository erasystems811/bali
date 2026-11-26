-- New ordering link (2026-11-26). Safe to re-run: only the old default link is replaced.
alter table reservation_settings alter column order_link set default 'https://order.baliabuja.ng';
update reservation_settings set order_link = 'https://order.baliabuja.ng' where order_link = 'https://baliabuja.mylo.africa';
