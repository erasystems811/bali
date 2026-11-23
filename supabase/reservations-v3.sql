-- Reservations v3 (2026-11-23): standalone app (no n8n). Idempotent. Run after reservations.sql + reservations-v2.sql.
alter table reservation_settings
  add column if not exists handover_number text,                       -- WhatsApp number that receives every completed reservation
  add column if not exists payments_enabled boolean not null default true,
  add column if not exists enquiry_intro text not null default 'Hi, welcome to Bali. Ask me anything about the venue.';

alter table knowledge_base
  add column if not exists keywords text not null default '',
  add column if not exists sort_order int not null default 0;

create table if not exists kb_unanswered (
  id bigserial primary key,
  phone_number text,
  question text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists wa_inbound (
  msg_id text primary key,
  created_at timestamptz not null default now()
);

-- a reservation can now be made without the guest ever texting first (form link), and guests give a separate contact phone
alter table reservations add column if not exists contact_phone text;
alter table reservations add column if not exists source text not null default 'form';
alter table reservations add column if not exists handed_over_at timestamptz;

-- default knowledge base entries (editable on the dashboard)
insert into knowledge_base (question, answer, keywords, sort_order)
select * from (values
  ('What time do you open and close?', 'We are open from 12pm to 10pm. The last table time is 9pm.', 'open close hours time opening closing', 1),
  ('How much is a reservation?', 'A reservation is NGN 20,500: NGN 20,000 is credited to your food and drinks order on the day, plus a NGN 500 service fee.', 'cost price fee pay payment how much deposit reserve', 2),
  ('Can I get a refund if I cancel?', 'Yes. If you cancel at least 24 hours before your reservation we refund the NGN 20,000. The NGN 500 service fee is not refundable.', 'refund cancel cancellation money back', 3)
) as v(question, answer, keywords, sort_order)
where not exists (select 1 from knowledge_base);

grant select, insert, update, delete on all tables in schema public to bali_service;
grant usage, select on all sequences in schema public to bali_service;

alter table web_sessions add column if not exists welcomed_at timestamptz;
