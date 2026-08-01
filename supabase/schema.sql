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
                     'staff', 'vendor', 'floor_manager', 'stage_manager', 'bar_lead',
                     'social_media_manager')),
  permission_level text not null default 'standard',
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index contacts_role_idx on contacts (role);

-- ---------------------------------------------------------------------------
-- bookings
-- One row per event. status walks the pipeline in Section 9. `mode` is a
-- legacy leftover from the old single-slot "one live negotiation at a time"
-- lock (removed 2026-08-01 -- every connected booking now relays to the PM
-- simultaneously, see connected_to_pm_at below) and is no longer written
-- meaningfully anywhere; kept only because dropping a column carries more
-- migration risk than leaving an inert one. One event per day: enforce via
-- a unique index on event_date for booking rows that aren't cancelled/lost,
-- since Bali only hosts one event/day.
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
  -- Starts null, not false: Stage 1 checks "is this field still missing"
  -- via IS NULL, so a not-null default here would make the bot silently
  -- skip ever asking "have you booked with us before?" (confirmed live --
  -- it did exactly that until this was fixed).
  is_existing_client boolean,
  client_reference text, -- IG handle / past event note, for existing clients
  staffing_type text check (staffing_type in ('full-time', 'part-time')),
  security_count int,
  security_notes text, -- "vigilante" needs etc.
  day_of_checklist_sent_at timestamptz, -- Section 6: setup checklist to supervisor + facility manager
  last_lawyer_nudge_at timestamptz, -- Section 5: 24h nudge while awaiting_contract
  -- Legacy leftover from the removed FIFO negotiation queue -- no longer
  -- written or read anywhere, see the `mode` comment above.
  negotiation_queued_at timestamptz,
  -- Set once, the first time this booking connects to the PM (on intake
  -- completion, see notifyPmOfCompletedIntake), and never cleared except by
  -- an explicit "[event]: close" from the PM. From that point on, the
  -- client's messages relay straight to the PM (bot only intercepts if it
  -- has a confident knowledge-base answer), simultaneously alongside any
  -- number of other connected bookings, until 7 days after event_date, when
  -- it reverts to the normal automated/KB-escalation flow (see stage1-code.js).
  connected_to_pm_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index bookings_one_active_event_per_day
  on bookings (event_date)
  where status <> 'cancelled';

create index bookings_status_idx on bookings (status);
create index bookings_client_idx on bookings (client_contact_id);

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
  -- Set on 'planning_relay_to_pm' rows (the PM-facing forward of a client's
  -- planning-phase message) so a PM swipe-reply to that specific WhatsApp
  -- message can be routed back to the right booking -- see pm-toggle-code.js.
  whatsapp_message_id text,
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
-- invoices
-- Stage 3. Line items are a variable list (whatever was actually agreed in
-- negotiation), so they're stored as jsonb rather than a fixed-column set.
-- subtotal/vat_amount/wht_amount/total_net_payable are always bot-calculated,
-- never asked for (spec Section 2 invoice field spec).
-- ---------------------------------------------------------------------------
create table invoices (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings (id),
  invoice_number text not null unique, -- e.g. "BALI-2026-003"
  date_issued date not null default current_date,
  bill_to_name text,
  bill_to_location text,
  line_items jsonb not null default '[]'::jsonb, -- [{description, amount}]
  payment_terms text, -- e.g. "100% Full Payment Due" or "60/40 split" -- extracted, not fixed
  subtotal numeric,
  vat_amount numeric,
  wht_amount numeric,
  total_net_payable numeric,
  status text not null default 'pending_pm_approval'
    check (status in ('pending_pm_approval', 'approved', 'sent_to_client', 'paid')),
  proof_of_payment_media_id text,
  created_at timestamptz not null default now()
);

create index invoices_booking_idx on invoices (booking_id);

-- ---------------------------------------------------------------------------
-- contracts
-- Stage 4. The bot never drafts contract language -- it collects these five
-- variable fields and relays them to the lawyer, who drafts the actual
-- document (boilerplate: obligations, liability, cancellation, etc. --
-- lawyer-owned, bot never touches it).
-- ---------------------------------------------------------------------------
create table contracts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings (id),
  organizer_legal_name text, -- confirmed with the client directly, never assumed from WhatsApp profile
  organizer_registered_address text,
  total_fee numeric,
  payment_terms text,
  sent_to_lawyer_at timestamptz,
  draft_media_id text,
  draft_received_at timestamptz,
  approved_by_pm_at timestamptz,
  sent_to_client_at timestamptz,
  signed_media_id text,
  signed_at timestamptz,
  created_at timestamptz not null default now()
);

create index contracts_booking_idx on contracts (booking_id);

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

-- ---------------------------------------------------------------------------
-- sandbox_outbound
-- Lives only in the bali_sandbox database (self-hosted droplet), never in
-- production bali. Every WhatsApp send the bot would have made, captured
-- instead of sent whenever SANDBOX mode is on (no META_TOKEN configured) --
-- see the SANDBOX guard atop each n8n/_src/*-code.js file's
-- sendWhatsApp*/uploadWhatsAppMedia functions. The sandbox test webpage
-- polls this to render each persona's chat window. message_id carries the
-- same fake wamid that gets written to pending_questions.whatsapp_message_id,
-- so the webpage can offer "reply to this message" and have it match the
-- real inbound router's swipe-reply resolution (message.context?.id)
-- exactly like a real WhatsApp reply would.
-- ---------------------------------------------------------------------------
create table if not exists sandbox_outbound (
  id uuid primary key default gen_random_uuid(),
  to_number text not null,
  kind text not null default 'text', -- 'text' | 'template' | 'document'
  message_text text,
  message_id text,
  created_at timestamptz not null default now()
);

create index if not exists sandbox_outbound_created_at_idx on sandbox_outbound (created_at);

-- ---------------------------------------------------------------------------
-- sandbox_snapshots
-- Lives only in the bali_sandbox database. One row per mutating sandbox
-- action (send, persona create), taken right before the action runs -- see
-- takeSnapshot() in sandbox-send-code.js and sandbox-persona-create-code.js.
-- sandbox-undo-code.js pops the most recent row and restores every sandbox
-- table to exactly this snapshot. id is bigserial (not uuid, unlike every
-- other table here) specifically so "most recent" is a plain id order, no
-- reliance on clock precision/skew across rapid-fire actions.
-- ---------------------------------------------------------------------------
create table if not exists sandbox_snapshots (
  id bigserial primary key,
  label text not null,
  tables_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists sandbox_snapshots_created_at_idx on sandbox_snapshots (created_at);
