# Bali — Sales & Onboarding Automation Spec

**Purpose:** WhatsApp bot handling client inquiries through contract signing and department handoff, for an event hospitality venue. Built as the first module of a general-purpose business operating system — architecture must not be hard-coded to sales/onboarding; it must expand to other departments and functions over time.

**Stack:** Supabase (database) · self-hosted n8n (orchestration/bot logic) · Retool free tier (admin visibility/editing) · Meta WhatsApp Cloud API, direct (not a BSP) · Claude/GPT API (conversation engine)

**One WhatsApp number** serves the whole business — customers, PM, staff, vendors, lawyer. The bot identifies who's messaging and routes accordingly. Role/permission structure should be built generally (levels + tags) even though only Customer and PM exist as active roles today.

---

## 1. Tone & Voice

- Bot must never sound like an AI. Warm, brief, conversational — like a staff member texting, not a company bot.
- Opens with a greeting, not a data request. Uses contractions. Asks one thing at a time, never a checklist.
- Example intro: *"Hey! 😊 Would you be interested in booking Bali for your event? Just let me know the date you're looking at and I'll check what's available."*

## 2. Stage 1 — Contact & Availability

1. Bot greets, asks for **date** and the client's **name** in the same message. Name is saved to their contact record and only ever used again to greet them personally at the start of a future new conversation — never repeated mid-conversation. Client can correct it any time by just stating it again.
2. If date is unavailable → bot suggests the nearest free date, or asks if the client has an alternative date in mind. If the date given has no year and has already passed this year, bot does not save it — it tells the client the date's passed and asks if they meant next year (or, if they did give a year and it's still in the past, just asks for a different date).
3. Bot asks for **event name** (early — this becomes the human-readable reference used in every internal message going forward; can be updated later if it changes).
4. Bot asks for **event type**.
5. Bot asks if this is a **new or existing client**.
   - New → proceed to negotiation handoff.
   - Existing → bot asks for Instagram handle or reference to a previous event/videos first, attaches this to the PM handoff so the PM has history before engaging.

*Reference material needed:* real invoice and contract examples (to be supplied) so the bot knows exactly which fields to extract from conversation and pre-fill.

### Invoice — field spec (from real example: BALI-2026-003)
**Bot must capture/generate per booking:**
- Invoice number (sequential, auto-increment)
- Date issued
- Bill To: client/organization name + location
- Project/event name
- Line items (description + amount) — **variable list**, built from whatever was actually agreed in Stage 2 negotiation, not a fixed set of rows
- Subtotal, VAT (7.5%), WHT deduction (2%), Total Net Payable — **calculated by the bot**, never asked for
- Reference (= invoice number)

**Fixed on every invoice (template, never asked):** Bali's business name/address, bank details (Moniepoint MFB, account name/number), VAT/WHT %, footer contact info.

### Contract — field spec (from real example: ActionAid Venue Use Agreement)
Bot does not draft the contract — it sends these fields to the lawyer, who drafts it:
- Organizer's full legal name + official registered address (must be explicitly confirmed with the client, not assumed from WhatsApp profile name)
- Event name
- Event date
- Event type (short category label)
- Total contract/venue fee agreed
- Payment split structure, as actually agreed in the negotiation (100% upfront, 60/40, or otherwise) — extracted from the logged conversation, same as the invoice, not a fixed rule

**Fixed on every contract (legal boilerplate, lawyer handles, bot never touches):** obligations, liability, cancellation tiers, postponement, dispute resolution, governing law, all standard clauses.

## 3. Stage 2 — Negotiation (PM-led)

- Bot hands the live conversation to the PM for pricing/negotiation.
- Bot stays passive but **logs the full conversation** — this becomes the source for the invoice and the event brief later.

### Reusable PM-led mode toggle (not just for this stage)
Since WhatsApp is one linear thread, the PM needs a way to take direct control of any client conversation, any time — not just once.
- PM types **"open [event name]"** → bot flips that booking to PM-led: goes passive, relays PM's messages straight through to the client, logs both sides.
- PM types **"close"** → bot flips back to bot-led automation. **"close" must be intercepted and never forwarded to the client.**
- PM handles **one PM-led conversation at a time** — must close one before opening another (avoids any risk of a message routing to the wrong client on a single linear thread).

## 3a. Standing Rule — Who the Bot Is Talking To

Any message from an internal contact (PM or otherwise) is directed **at the bot itself** by default — never relayed to a client or another staff member. The bot only becomes a passive relay for that person's messages when they've explicitly opened a session ("open [event name]"). Outside of that, the PM/staff member is always talking to the bot.

- **Invoice corrections:** PM replies to/quotes the specific invoice message to request a change (same disambiguation as escalations — no ref codes). Bot applies the correction, regenerates the invoice, and re-sends it for PM approval before it goes to the client.
- This rule generalizes across the whole system — not just PM, and not just invoices. Any staff member's messages default to bot-directed unless a session is explicitly open.

## 4. Stage 3 — Invoice & Staffing Info

- Once price is agreed, bot drafts an invoice from the logged negotiation — **paid items only**.
- **Payment structure (100% upfront, 60/40 split, or otherwise) is not a fixed rule** — the bot extracts whatever was actually agreed from the logged negotiation and reflects it correctly in the generated invoice. No separate question needed; it comes from the conversation like the line items.
- **Invoice goes to the PM for approval before being sent to the client** — same pattern as the contract. This is the safety net if the bot misreads any term from the conversation.
- Bot asks PM (closed/direct question, not open-ended): full-time or part-time staff needed. Stored separately — this is operational data for HR, not an invoice line item.
- Bot sends invoice to client, asks for **proof of payment**, forwards it to PM to confirm receipt.

## 5. Stage 4 — Contract

1. Bot sends event details to the **lawyer's WhatsApp number** (lawyer is a known internal contact on the same system).
2. Lawyer drafts contract, sends back to bot.
3. Bot sends draft to PM for approval.
4. PM approves → bot sends to client.
5. **Bot nudges the lawyer every 24 hours** until the contract is sent, if delayed.
6. **Signature detection:** client sends the signed document back as a **PDF**; PM confirms receipt/validity to the bot. (No e-signature tool for v1.)

## 6. Stage 5 — Contract Signed → Department Fan-Out

On confirmed signature, bot fans out role-specific briefs. Each department gets **only what's relevant to them** — this is the permission/visibility model applied to automated distribution.

| Department | Gets | Source |
|---|---|---|
| HR | Event date, staff count/type needed | Collected from PM by bot |
| Procurement | Current stock + stock needed for event | Ties into recipe-based inventory system (see below) |
| Accounts | Revenue/contract split information only | From signed contract |
| Event Assistant | General brief — event overview, no revenue/payment info | Bot-drafted from monitoring the PM–client conversation |
| Security | Security/bouncer count + "vigilante" needs | Collected from PM if not already provided |
| All staff | Event date + info specific to their role | — |

- **Day-of:** a checklist is sent to the **supervisor** and **facility manager** to confirm event setup.
- **Standing rule:** for any field the bot is missing (e.g. security count, staffing type), it asks the PM directly with a closed/specific question — never assumes, never over-asks.
- **PM disambiguation:** no reference codes. If the PM replies without clearly quoting/replying-to the specific message being answered, the bot asks them to reply directly to that message rather than guessing which booking it concerns.

## 7. Post-Event — Inventory Reconciliation

- Client sells cocktails/mocktails (mixed drinks), not bottled units — usage can't be tracked by bottle count alone.
- **Recipe-based tracking:** every drink gets a fixed recipe (exact ml per ingredient), measured with jiggers (not free-poured).
- Expected usage = recipe × quantity sold, summed across all drinks sharing an ingredient.
- Compared against actual stock depletion at count intervals. Variance = the actual leakage/theft/waste signal.
- **Mismatches escalate to the supervisor.**

## 8. Knowledge Base (general client questions, outside the scripted flow)

- Standalone, always-updatable KB table (topic/question → answer).
- Bot checks KB first for any client question outside the onboarding script.
- **Found →** bot answers directly, no PM involvement.
- **Not found →** bot tells the client it will check and get back to them; flags PM with the exact question (identified by event name, not a ref code).
- **KB addition is opt-in per escalation** — after the PM answers, bot asks if it should save the answer to the KB. Only adds it if PM says yes. Not every question is a pattern worth institutionalizing.

## 9. Core Data Objects (Supabase)

Keep structure generic — a `type`/`department` field on shared tables, not one table per department — so new roles/departments can be added later without redesigning the schema.

- `Contacts` — phone number, role (customer/PM/lawyer/staff/vendor...), permission level/tags
- `Bookings` — event name, date, event type, status (inquiry → negotiating → invoiced → awaiting_contract → contract_drafted → awaiting_pm_approval → sent_to_client → signed → onboarded), mode (bot-led / pm-led)
- `Conversations` — full message log per booking, tagged by stage
- `Knowledge Base` — question, answer, last updated
- `Recipes` / `Ingredients` / `Stock` — for post-event inventory reconciliation
- `SOPs` — general process documents, category-tagged, generic across departments

## 9a. Number Setup

- **Bali WhatsApp number:** a dedicated business SIM/line registered under the existing Meta Business Manager as the single WhatsApp Cloud API number for the business — used by customers, PM, staff, lawyer, and vendors alike.
- **Contacts table:** every staff member's phone number is entered here with their role, before launch. On any incoming message, the bot looks up the sender's number first to decide which flow/permissions apply.
- **Unrecognized-number fallback:** any number not found in the Contacts table is treated as a customer by default and routed into the sales flow (Section 2).

## 10. Open / Not Yet Decided

- None outstanding for this stage — ready for build.

## 11. What's Next (not in this spec)

Individual department processes to be audited and specced separately, one at a time: HR, Procurement, Security, Facility, Supervisor, Event Assistant — using the same audit frame (Intake → Production → People → Visibility).
