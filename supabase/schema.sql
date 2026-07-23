-- Bali Sales & Onboarding — Supabase schema
-- Mirrors Section 9 of bali-sales-onboarding-spec.md.
-- Generic type/department columns instead of per-department tables,
-- so new roles/departments can be added without a schema redesign.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- contacts
-- Every person the one WhatsApp number talks to: customers, PM, lawyer,
-- staff, vendors. Looked up first on every inbound message (Section 9a).
-- ---------------------------------------------------------------------------
create table contacts (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  name text,
  role text not null default 'customer'
    check (role in ('customer', 'pm', 'lawyer', 'hr', 'procurement', 'accounts',
                     'event_assistant', 'security', 'supervisor', 'facility_manager',
                     'staff', 'vendor')),
  permission_level text not null default 'standard',
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index contacts_role_idx on contacts (role);

-- ---------------------------------------------------------------------------
-- bookings
-- One row per event. status walks the pipeline in Section 9; mode drives
-- whether the bot or the PM is currently driving the client conversation.
-- One event per day: enforce via a unique index on event_date for booking
-- rows that aren't cancelled/lost, since Bali only hosts one event/day.
-- ---------------------------------------------------------------------------
create table bookings (
  id uuid primary key default gen_random_uuid(),
  -- event_name / event_date start null: Stage 1 collects them one message at a
  -- time (see 02-stage1-sales-flow.json), so a booking row exists as an
  -- in-progress intake before either is known. App logic requires both filled
  -- before status can move past 'inquiry'.
  event_name text,
  event_date date,
  event_type text,
  status text not null default 'inquiry'
    check (status in ('inquiry', 'negotiating', 'invoiced', 'awaiting_contract',
                       'contract_drafted', 'awaiting_pm_approval', 'sent_to_client',
                       'signed', 'onboarded', 'cancelled')),
  mode text not null default 'bot-led' check (mode in ('bot-led', 'pm-led')),
  client_contact_id uuid not null references contacts (id),
  is_existing_client boolean not null default false,
  client_reference text, -- IG handle / past event note, for existing clients
  staffing_type text check (staffing_type in ('full-time', 'part-time')),
  security_count int,
  security_notes text, -- "vigilante" needs etc.
  day_of_checklist_sent_at timestamptz, -- Section 6: setup checklist to supervisor + facility manager
  last_lawyer_nudge_at timestamptz, -- Section 5: 24h nudge while awaiting_contract
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index bookings_one_active_event_per_day
  on bookings (event_date)
  where status <> 'cancelled';

create index bookings_status_idx on bookings (status);
create index bookings_client_idx on bookings (client_contact_id);

-- Only one booking may be pm-led at a time (single-PM system for v1).
-- Enforced here as a DB-level backstop even though the primary enforcement
-- is in the n8n PM-toggle workflow.
create unique index bookings_single_pm_led
  on bookings (mode)
  where mode = 'pm-led';

-- ---------------------------------------------------------------------------
-- conversations
-- Full message log per booking, tagged by stage. Source of truth for
-- invoice drafting and event briefs later.
-- ---------------------------------------------------------------------------
create table conversations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings (id),
  sender_contact_id uuid references contacts (id), -- null if from an unrecognized number
  direction text not null check (direction in ('inbound', 'outbound')),
  message_text text,
  media_url text,
  stage text, -- e.g. 'contact_availability', 'negotiation', 'invoice', 'contract'
  created_at timestamptz not null default now()
);

create index conversations_booking_idx on conversations (booking_id);
create index conversations_stage_idx on conversations (stage);

-- ---------------------------------------------------------------------------
-- knowledge_base
-- Standalone, always-updatable KB for off-script client questions.
-- Matching approach (v1): whole table is passed as OpenAI context, no
-- embeddings — see docs/setup.md.
-- ---------------------------------------------------------------------------
create table knowledge_base (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  last_updated timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- recipes / ingredients / stock
-- Schema only for now — Section 7 reconciliation logic is deferred.
-- ---------------------------------------------------------------------------
create table ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  unit text not null default 'ml'
);

create table recipes (
  id uuid primary key default gen_random_uuid(),
  drink_name text not null unique
);

create table recipe_ingredients (
  recipe_id uuid not null references recipes (id),
  ingredient_id uuid not null references ingredients (id),
  quantity_ml numeric not null,
  primary key (recipe_id, ingredient_id)
);

create table stock (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients (id),
  counted_at timestamptz not null default now(),
  quantity_ml numeric not null
);

-- ---------------------------------------------------------------------------
-- pending_questions
-- Generic "bot is waiting on the PM for X" tracker. Powers two spec rules:
-- the Section 4/6 closed-question flow (ask PM directly for a missing field)
-- and the Section 6 reply-to disambiguation rule (match the PM's reply back
-- to the exact question via the bot's outbound WhatsApp message id).
-- ---------------------------------------------------------------------------
create table pending_questions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings (id),
  field_name text not null, -- e.g. 'staffing_type', 'security_count', 'kb_escalation'
  question_text text not null,
  whatsapp_message_id text,
  asked_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index pending_questions_open_idx on pending_questions (booking_id) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- sops
-- General process documents, category-tagged, generic across departments.
-- ---------------------------------------------------------------------------
create table sops (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  content text not null,
  created_at timestamptz not null default now()
);
