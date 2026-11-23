-- Reservations v2 (2026-11-23): web chat (Meta-fee avoidance) + Paystack payment. Idempotent.

-- settings
alter table reservation_settings
  add column if not exists reservation_fee_kobo int not null default 2000000,   -- NGN 20,000, credited to the guest's order
  add column if not exists service_fee_kobo int not null default 50000,         -- NGN 500, not refundable
  add column if not exists hold_minutes int not null default 15,                -- unpaid hold on the table
  add column if not exists refund_hours int not null default 24,                -- guest cancel >= this many hours before = refund of the reservation fee
  add column if not exists order_link text not null default 'https://baliabuja.mylo.africa',
  add column if not exists welcome_image_url text,
  add column if not exists welcome_text text not null default 'HEY, WELCOME TO BALI. PLEASE TAP THE BUTTON BELOW TO MAKE A TABLE RESERVATION.';

-- reservations: payment fields + new statuses
alter table reservations drop constraint if exists reservations_status_check;
alter table reservations add constraint reservations_status_check
  check (status in ('pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired'));
alter table reservations
  add column if not exists hold_expires_at timestamptz,
  add column if not exists paystack_ref text,
  add column if not exists paystack_url text,
  add column if not exists paid_amount_kobo int,
  add column if not exists paid_at timestamptz,
  add column if not exists refund_amount_kobo int,
  add column if not exists refund_status text;   -- null | refunded | failed | not_eligible
create index if not exists reservations_paystack_idx on reservations (paystack_ref);

-- web chat
create table if not exists web_sessions (
  token text primary key,
  phone_number text not null unique,
  created_at timestamptz not null default now(),
  last_seen timestamptz
);
create table if not exists web_messages (
  id bigserial primary key,
  phone_number text not null,
  direction text not null check (direction in ('in', 'out')),
  body text,
  interactive jsonb,            -- {type:'cta_url',label,url} | {type:'chips',options:[..]} | null
  created_at timestamptz not null default now()
);
create index if not exists web_messages_phone_idx on web_messages (phone_number, id);

alter table reservation_drafts add column if not exists cta_sent_at timestamptz;

grant select, insert, update, delete on web_sessions, web_messages to bali_service;
grant usage, select on all sequences in schema public to bali_service;
