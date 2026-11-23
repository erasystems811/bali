-- Table reservations (2026-11-23). Idempotent.
create table if not exists reservation_settings (
  id int primary key default 1 check (id = 1),
  venue_name text not null default 'Bali',
  open_time text not null default '12:00',          -- first seating, venue local time HH:MM
  close_time text not null default '22:00',         -- closing; last seating = close - slot_minutes
  slot_minutes int not null default 60,
  max_guests_per_slot int not null default 40,      -- total guests the venue seats per slot
  max_guests_per_booking int not null default 12,   -- bigger parties are passed to staff
  min_notice_minutes int not null default 60,
  max_days_ahead int not null default 60,
  closed_weekdays int[] not null default '{}',      -- 0=Sunday .. 6=Saturday
  tz_offset_minutes int not null default 60,        -- Africa/Lagos
  venue_notes text not null default ''
);
insert into reservation_settings (id) values (1) on conflict do nothing;

create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  phone_number text not null,
  contact_id uuid references contacts (id),
  guest_name text,
  guests int not null check (guests > 0),
  starts_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  cancelled_by text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reservations_starts_idx on reservations (starts_at);
create index if not exists reservations_phone_idx on reservations (phone_number);

create table if not exists reservation_drafts (
  phone_number text primary key,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists reservation_log (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  message_text text,
  created_at timestamptz not null default now()
);
create index if not exists reservation_log_phone_idx on reservation_log (phone_number, direction, created_at desc);

grant select, insert, update, delete on reservation_settings, reservations, reservation_drafts, reservation_log to bali_service;
