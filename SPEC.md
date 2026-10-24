# Control Room V3 — Build Spec

This is the single source of truth for what we build. Read it fully before writing code.
Also read `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md` and `dataset/SCHEMA.md` in this repo.

## 1. The idea in one paragraph

Agents do the operations work in the background. A person only sees what needs a person,
and each item arrives as a ready decision: what happened, what the agent already found out
(every fact with its source and time), what it proposes, and one-click answers. The person
approves, rejects, or writes one sentence back to the agent, and the agent continues by
itself. Everything any channel says about an order (driver chat, support, internal Slack-style
notes, email, calls, GPS, bookings) lands on one timeline per order, so nobody has to know
where something was agreed. There is also an "Agents" view (the aquarium) where you can
watch what the agents are doing right now.

What Bahn told us (keep this in mind for every decision):
- Ops opens the app in the morning and must see only what needs them. Today they scroll everything.
- Support (Intercom) and the ops platform are separate; context is dug up by hand.
- Information is scattered: someone agreed something with a driver, others do not know.
  Example: map shows driver driving the wrong way, but one person knows it was agreed.
- Nobody writes reports; capture must be automatic.
- Do not use LLMs for everything: code for rules and arithmetic, LLMs for unstructured text.
- Autonomy grows over time as agents earn trust.
- Ambitious beats cautious. Must be crystal clear to non-engineers. No developer-tool look.

## 2. Hard rules (from the brief)

- The agent never contacts a customer (anyone who pays) on its own. Drivers and pickup sites are fine.
- A person approves before the agent changes a booking, a date, a cost, or messages a customer.
  Reading, asking and looking things up need no approval.
- The agent is a real LLM in a tool-use loop. Everything around it (phone, ferry prices,
  repair shops, the driver's replies) may be mocked.
- Everything stays fictional. No real people, bookings or messages.
- Must run from a fresh clone with the README steps.

## 3. Time and data

- The dataset is a snapshot at `2026-10-21T09:00:00Z`. The app has a simulated clock that
  starts there. Never use the real current time for business logic. Put the clock in one module
  (`lib/clock.ts`). The demo page can advance it.
- Keep the starter's Postgres schema and seed. Add new tables via Drizzle (section 5).
- The starter already loads every collection: core tables plus `related_records`
  (collection, id, order_id, details jsonb) for the rest.
- `display_lane` is a convenience field, not truth. Derive state from records.
- A quote (`travel_options`) is never a booking (`travel_reservations`). An alert is a signal,
  not a diagnosis. A driver message is not a location fix. A submitted proof is not approved.
  The UI must keep these distinctions visible in words.

## 4. Use the whole dataset

- All 100 orders appear in search and in the case view.
- Every order with a live signal gets a real agent run (backfill), not hand-written cards.
  Live signal = open/acknowledged alert, open work item, open incident, unresolved endpoint claim,
  pending/approved-awaiting/failed agent proposal, open support inbox thread, or open conversation
  with an unanswered inbound message. This snapshot has exactly **30** such orders (`lib/signals.ts`;
  `npm run urgency` lists them).
- Every message (202) goes through the Classifier once to extract facts and agreements.
- Quiet orders are checked by code only and show up in the Agents view as quiet checks.

## 5. Data layer

### 5.1 New tables

```
timeline_entries   id, order_id (nullable for unlinked), occurred_at, received_at,
                   source        -- order | gps | driver_chat | support | slack | email | call | booking | quote | alert | agent | person | system
                   channel       -- raw channel value from the dataset, e.g. support_chat
                   author_type, author_id, author_label
                   kind          -- message | position | booking | quote | alert | event | proposal | decision | fact
                   summary       -- one plain-language line, written by code from fields (no LLM)
                   body          -- full text when it is a message
                   status        -- claimed | verified | quote | booked | superseded | signal | done
                                    (null when none fits, e.g. a sold-out check: not a quote, not a booking)
                   visibility    -- public | internal
                   evidence      -- jsonb {table, id}  (required, never null)
                   language      -- authored language of a message
                   origin        -- dataset (rebuilt by timeline:build) | live (ingest, agents, decisions)
facts              id, order_id, subject, value, status (claimed|verified|superseded),
                   source_entry_id, stated_by_label, stated_at, superseded_by
                   kind          -- fact | agreement
                   origin        -- dataset (derived by code) | classifier | agent
agent_runs         id, order_id, agent, model, trigger, started_at, finished_at,
                   status (running|waiting_driver|waiting_person|done|failed), outcome_summary, next_check_at,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   cost_usd      -- computed in code from the prices in lib/models.ts
agent_steps        id, run_id, idx, at, type (thought|tool_call|tool_result|message), tool, input jsonb, output jsonb, summary
cards              id, order_id, run_id, created_at, kind (decision|question), status (open|approved|rejected|answered|expired),
                   headline, what_happened, findings jsonb [{text, source_entry_id, source_label, at}],
                   proposal jsonb {action, params, effect_text, requires_approval_reason},
                   options jsonb [{id, label, action, params}],
                   consequence_at, consequence_text, severity (safety|high|normal), verifier_notes jsonb
                   origin        -- alert (temporary, built by code in phase 2) | agent
decisions          id, card_id, decided_at, actor ('Ops' for the demo), choice, reply_text, executed_effect jsonb,
                   undone_at     -- set when the person pressed Undo inside the undo window
policies           action, level (auto|approval|never), approved_unchanged_count, decided_count, note
eval_cases         id, card_id, created_at, case_snapshot jsonb, agent_proposal jsonb, human_correction jsonb, last_result
demo_events        id, created_at, order_id, kind, payload jsonb   -- evidence for ingested demo entries
sim_clock          id, now_at                                       -- the simulated clock (one row)
search_documents   order_id, reference, content, tsv (generated)    -- full-text search, rebuilt with the timeline
```

None of these tables has a foreign key to a starter table, so `npm run db:seed` can still replace
the snapshot. Timeline entry ids are deterministic (`messages:msg-…`, `alerts:alert-…:ack`) so facts
and cards keep pointing at the same entry across rebuilds.

### 5.2 `scripts/build-timeline.ts`

Reads the seeded tables and writes one `timeline_entries` row per meaningful record:
messages, tracking_observations, travel_reservations (booked), travel_options (quote),
alerts, incidents, work_items, operational_events, agent_proposals, internal_notifications,
support_inbox_messages, order_notes, documents, proofs, expenses.
Also: time windows, handover details and claims (kind `fact`), site visits, terminal gate
records, driver travel and custody reports, key-tracking events. Operational events that only
repeat one of these records (`alert.raised`, `travel.booked`, `proof.submitted`, …) are skipped.
Map sources: support_chat → support (label "Support chat (Intercom)"), site_chat → support,
internal_note and internal_notifications → slack (label "Internal (Slack)"), operator order notes → slack,
customer order notes → order, driver_chat/app_chat/whatsapp/driver_app_chat → driver_chat,
customer_email/email → email, site_call → call, tracking_observations → gps.
Support inbox messages are filed under an order only when the link is confirmed (`linked_order_ids`);
candidate matches stay unlinked and appear in the case file as "may concern this order".
Summaries are generated by code from fields. Idempotent: a rebuild replaces the `origin = dataset`
rows and keeps live rows. Add `npm run timeline:build`.

### 5.3 `lib/case.ts`

`getCase(orderId)` returns one compiled case file used by BOTH the agents and the Case view:
order header (reference, car, route, customer, driver, stage in plain words), key times
(selected pickup slot, delivery promise, ferry check-in cutoffs) each with source,
current facts and agreements, open items (alerts, work items, incidents, cards), active plan
and bookings vs quotes, and the last 40 timeline entries. Also `timeline(orderId, since)` and
`search(query)` (Postgres full text over reference, registration, make/model, customer, driver, city, message bodies).

### 5.4 Ingest

`POST /api/ingest` accepts a timeline entry (same shape, evidence pointing to a new row in a
`demo_events` table). It stores it, then triggers the Classifier, then routing. The demo page uses it.

## 6. Urgency (code only, `lib/urgency.ts`)

For each order compute `consequence_at` = the next moment when something is lost. Candidates:
- **Already missed** (these win, and sort first): a selected pickup slot that ended without a
  collection (CD-420593), or a delivery promise that ended without a delivery.
- ferry `check_in_cutoff_at` on a booked reservation while a ferry alert is open (CD-420603).
  An order can have no reservation at all, only quotes and sold-out checks (CD-420299); then the
  pickup slot is the next consequence.
- selected pickup slot start for orders not yet collected (or the yard release slot after a transfer).
- customer delivery promise end for orders not delivered.
- booked driver travel (train, flight) departure, when the open alert or task is about the driver
  (CD-420449: "Driver's train from Aalborg leaves in 1 h 25 min").
- a proposed but unselected pickup slot for intake orders ("Planned pickup in Hamburg on Mon 26 Oct
  10:00 is not confirmed yet").
- only when none of the above exists: alert triggered_at + 2 h (critical/high) or + 8 h (medium/low).
  If that time is still ahead it sorts the card, but the sentence does not invent a deadline:
  "No deadline in the records; alert raised 2 h 48 min ago". If it has passed, the card has no
  deadline and sorts **last**. Otherwise a stale alert (CD-420164, raised Monday) would outrank a
  ferry check-in that closes in 3 hours.
Sort the For you queue: severity `safety` first, then ascending `consequence_at`, no deadline last.
Each card shows the consequence as a sentence that names the place: "Ferry check-in in Hamburg
closes in 3 h, at 14:00", "Customer was promised delivery in Hamburg by today 16:00". Never show a
raw score. Time risk (amber) = missed, or due within 4 hours.

## 7. Agents

Use the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), tool use, manual loop with a step cap.
Model ids in `lib/models.ts` so they can be changed in one place, together with their prices.

Cost and context (added for phase 4):
- **Prompt caching** on every system prompt and on the tool definitions (`cache_control`), so
  repeated runs and later loop steps reuse them.
- **`get_case` returns compact text, not JSON**: about 2,000 tokens, one line per item with its
  source and time (e.g. `08:58 Driver (driver chat): "I will wait here…" [messages:msg-…]`).
  The entry id stays on the line so findings can cite it.
- **Investigator step cap: 12.** Tool results are truncated to a fixed size before they go back
  to the model; the full result is kept in `agent_steps`.
- **Tokens and cost per run**: input, output, cache read and cache write tokens, and `cost_usd`
  computed in code from `lib/models.ts`, stored on `agent_runs` and shown in the Agents view.

| Agent | Model | Job | Can do on its own |
|---|---|---|---|
| Classifier | `claude-haiku-5-5` | Every inbound message: which order (if unlinked), intent, does it change a fact, extract facts and agreements (JSON output) | Write facts only |
| Router | code | Decide: nothing, Driver support, Investigator, or a monitor check | n/a |
| Driver support | `claude-sonnet-5-5` | Reply to drivers in their language; routine answers from the case file; hand hard ones to Investigator with context | Reply to driver |
| Investigator | `claude-sonnet-5-5`; `claude-opus-5-5` when severity is safety, cost > €500, or evidence conflicts | Investigate with tools, then resolve or create a card | Read, ask driver/site, look up options |
| Verifier | `claude-haiku-5-5` | Check every card claim against its cited source before a person sees it; flag a quote shown as a booking etc. | Annotate the card |
| Narrator | `claude-haiku-5-5` | One plain sentence per run for the Agents view | Summarize |
| Executor | code | Carry out an approved action exactly; record the effect as a timeline entry | Only approved actions |
| Simulated driver | `claude-haiku-5-5` | Demo only: plays the driver, answers from a scenario note + case file | n/a |

Investigator tools:
- `get_case(order_id)`, `timeline(order_id, since)`, `search(query)` — free
- `ask_driver(order_id, question)`, `ask_site(order_id, question)` — free; reply comes from the
  simulated driver/site; the run pauses with status waiting_driver and resumes on reply
- `find_repair_shops(near)`, `ferry_options(route, after)`, `travel_options(from, to, after)` —
  free; mocked, deterministic, seeded from the dataset where it has data (e.g. travel_options rows)
- `propose(card)` — creates a card; anything that changes a booking/date/cost or messages a customer
- `resolve(summary)` — ends the run with no card when nothing needs a person
- There is no tool to contact a customer. Customer contact is always a proposal.

Policies (table `policies`, enforced in code, not in prompts): read/ask/look up = auto;
reply to driver routine = auto; republish offer, raise fee, book ferry/train/hotel,
change pickup/delivery time, customer message, repair/tow cost = approval.

System prompts live in `lib/agents/prompts/*.md`. They must tell the model: cheap work first
(read, then ask, then look up), cite the source entry id for every finding, never present a
quote as a booking, stop and resolve when the facts explain the signal (e.g. an agreement in
the timeline explains a GPS deviation), treat a driver's message as a claim and not a location
fix (when it disagrees with GPS, show both and the gap), and keep card language plain (ops words,
no ids in text).

`npm run agents:backfill` runs Classifier over all messages and Investigator over every live-signal
order (concurrency 4). Results are stored in the DB AND exported to `fixtures/agent-runs.json`.
If `ANTHROPIC_API_KEY` is missing, seed loads the fixtures so a fresh clone still shows real
agent output (demo mode banner: "Showing recorded agent runs"). Export every run as a trace to `traces/<order-ref>-<run-id>.json`.

## 8. Screens

Product language: English. Ops words: order, car, driver, gig, pickup, delivery, ferry, customer, site.
Never show: assignment, segment, endpoint, enum values, record ids, JSON.

Left rail (narrow): For you (with count), Agents, Orders (search), Settings. Top: search / ask field (⌘K).

1. **For you** (`/`) — the home screen. Ordered list of open cards. Each row: severity mark,
   headline (car + what happened, one line), consequence sentence, agent proposal in one line,
   and the buttons. Click expands the card in place (no navigation): findings with source chips,
   proposal effect, options, reply box. Approve/reject/answer removes it with a short undo toast.
   **Undo window: an approved action is executed only after 8 seconds.** The toast says what
   will happen and counts down: "Booking in 8 s · Undo". Undo inside the window cancels it and
   the card returns; after the window the Executor runs and the effect cannot be undone from the
   toast. A card built by code (no agent, no proposal) shows its buttons only when opened, and
   not in the accent colour; blue is for agent proposals that need approval.
   Header line, for example "17 need you · agents are handling 13 · nothing open on 70".
   "Agents are handling" counts only orders with an agent run and no open card. Until agents
   have run, those orders read "13 more with open items, no agent run yet". The last part is
   "nothing open on N", not "moving normally": delivered, cancelled and new orders are not moving.
   (There are 30 live-signal orders, so "need you" + "handling" + "no run yet" = 30.)
   Empty state: "Nothing needs you right now." with the handling counts.
2. **Agents** (`/agents`) — the aquarium. One row per active or recent run: order, agent name,
   status (Working / Waiting for driver / Waiting for you / Done), the Narrator sentence, next check time,
   and the run's model, tokens and cost (e.g. "Sonnet · 18k tokens · $0.07"; totals for the day in the header).
   Live via SSE. A small filter: Active / Done / Quiet checks. Clicking opens the run trace in plain
   words (steps as sentences; raw tool JSON hidden behind "Show details").
3. **Order** (`/orders/[reference]`) — the case. Top: one-line status sentence, car, route, driver,
   key times. Then "Agreed" (facts and agreements with source and time), open card if any,
   and the full timeline with source filter chips (All, Driver, Support (incl. calls), Internal,
   Email, GPS, Bookings, Alerts, Agents, People). Every entry shows source label and time.
   Bookings vs quotes labelled ("Booked", "Quote, not booked", "Sold out" / "Availability check").
   Slots and promises are shown once, under key times, not repeated under Agreed. On the order
   page the card shows only its body (the header already says what is wrong and when).
   Wide screens: timeline left, key times / Agreed / route and travel right; one column below 1100 px.
4. **Search / ask** — ⌘K field. Typing a reference, plate, name or city lists orders.
   A question ("why is CD-420603 at risk?") goes to the Investigator in read-only mode and answers inline with sources.
5. **Settings → Agent permissions** — the policies table in plain words with the approval counter
   ("approved unchanged 14 of 15 times") and a level selector. **Settings → Learning** — eval cases
   created from rejected or changed cards.
6. **Demo** (`/demo`) — clearly labelled "Demo controls". Simulated clock with +15 min / +1 h.
   Driver phone mock (chat as the driver for a chosen order). Buttons to inject scripted events:
   red warning light (CD-420322), GPS deviation explained by agreement (see 9.5), Slack note, customer email.

## 9. Demo scenarios (must work end to end)

1. CD-420299 ferry sold out, agent booking attempt failed: card shows booked vs only quoted
   (no ferry is booked; the Sat 24 Oct 00:00 CEST sailing is sold out, the Sat 24 Oct 14:00 CEST
   sailing is a €387 quote checked at 09:00 CEST). **The earlier booking attempt timed out without a
   confirmation, so the agent first reconciles it with the ferry line (mocked lookup) before any
   new booking; otherwise the car could be booked twice.** Then it re-checks the quote and
   proposes the 14:00 sailing + a hotel for the overnight stop. That sailing still arrives before
   the 27 Oct delivery promise, so the customer promise does not change and no customer message
   is needed (the customer asked to approve any later delivery date, msg 07:56 UTC). Approve →
   8-second undo window → Executor records the booking (mock) → Agents view shows it.
2. CD-420322 red warning light, live: inject driver message → Classifier → Investigator (Opus, safety)
   asks driver if safe, exact location, photo → simulated driver answers → looks up car owner and
   delivery promise, repair shops → card: "Car stopped, driver safe. Call the dealer: their own
   roadside assistance or tow? **Today's delivery (promised in Hamburg by 16:00) will be late.**"
   (The promise is Wed 21 Oct 12:00–16:00 CEST, the same day as the snapshot, not tomorrow.)
   Options: Call dealer (customer contact → approval), Book tow, Reply. Person replies
   "call the seller first" → agent continues.
3. CD-420593 empty pickup: driver at site, car not found; agent asks site, proposes next step.
4. CD-420449 driver may be ill: backup driver prepared; card asks to confirm switching.
5. GPS deviation explained (authored demo event, fictional): a moving order's driver heads
   away from destination; Investigator finds an agreement in the support/Slack timeline
   ("driver collects the keys via Lappeenranta") and resolves without a card. Agents view:
   "Checked a route deviation — explained by an agreement in support chat at 12:04."
   **The dataset has no map coordinates** (tracking only has km to go, progress and an ETA), so the
   authored deviation is: new GPS observations where **km to go increases**, plus a **driver message
   naming a city** ("Turning off to Lappeenranta now"). The agreement itself is an authored
   support/Slack entry earlier the same day.
6. **CD-420603 Investigator test case (conflicting evidence).** The driver says (support chat,
   06:58 and 07:31 UTC) they are "in the queue before the terminal". The last GPS position
   (08:06 UTC) shows 1,772 km to go on a 2,391 km route, about 160 km short of the Hamburg
   terminal. The booked ferry's check-in closes at 14:00 CEST. The driver's message is a claim,
   not a location fix: the card must show both statements with their sources and the gap between
   them, must not treat the driver as "at the terminal", and must keep the booked crossing
   (Driver travel asked the ferry line for a later crossing, not confirmed). Conflicting evidence
   means the Investigator runs on Opus.

## 10. Design

Calm, dense, readable. Think Apple Mail / Linear, not an admin template.
- System font stack (`-apple-system, BlinkMacSystemFont, "Inter", sans-serif`), base 15px, line-height 1.5.
- Neutral greys, one accent (blue) for primary action, red only for safety, amber for time risk. Light and dark.
- No cards inside cards, no heavy shadows, no badges everywhere. Whitespace over borders.
- Every page has a real empty state and a loading state (skeleton lines, not spinners).
- Times shown relative to the simulated clock and absolute on hover. "The site's time zone" is
  ambiguous on an order (pickup site, delivery site, ferry terminal), so: key times are shown in
  their own place's zone with the zone name ("Wed 21 Oct 14:00 CEST", place "Hamburg"); timeline
  and chip times use the pickup zone until the car is collected, then the delivery zone, and the
  timeline header says which ("times in Lahti time"). The top bar clock shows Helsinki time.
- Source chip style: small grey text "Driver · 08:42", "GPS · 3 h old", "Quote, not booked".
- Must be usable without a tutorial: every button says what it does ("Approve: book 18:00 ferry").

## 11. Build phases (each ends with its checks passing and a PROCESS-LOG.md entry)

1. Data layer: tables, timeline build, getCase, search. Check: `npm run case CD-420322` prints a sensible case file.
2. Urgency + For you list from existing dataset signals (no LLM yet, temporary cards from alerts). Check: safety case first; consequence sentences make sense for 10 orders.
3. Order (case) view with timeline, sources, Agreed section. Check: screenshot 3 orders with Playwright, review.
4. Agents: models module (ids + prices), tool layer with mocks, Investigator loop (step cap 12,
   truncated tool results, compact-text get_case), prompt caching on system prompts and tool
   definitions, tokens and cost stored per run, Verifier, cards from agent output. Check: run
   CD-420322, CD-420299 and CD-420603; cards are specific and cite sources; CD-420299 reconciles
   the timed-out booking before proposing a new one; CD-420603 shows the driver-message/GPS gap.
5. Decisions: approve / reject / reply, Executor (runs only after the 8-second undo window),
   policies, eval cases. Check: scenario 1 end to end, including Undo inside the window.
6. Classifier + ingest + Router + Driver support + simulated driver + Demo page. Check: scenario 2 live.
7. Agents view (aquarium) with SSE and Narrator; backfill script; fixtures + demo mode. Check: fresh DB, no API key → app still shows recorded runs.
8. Polish: empty/loading states, ⌘K, Settings pages, scenario 5, README. Check: Playwright screenshots of every screen in light and dark; fix anything ugly.

## 12. Added after phase 7 (requested during the build)

- **Card call**: findings and option steps are added one flat call at a time (`add_finding`, `add_step`), then a flat `propose`.
- **Disruption feed** (`disruptions`, fictional): a rail strike in Germany (hits CD-420123's booked train), a protest near Lille
  (published by the Demo button "Scenario 7: protest near Lille"), an E18 closure that touches no order. Investigator tool
  `check_disruptions(region, from, to)`. A Monitor rule in code matches active notices to routes, pickups, deliveries and
  drivers' booked trains and starts an Investigator run before any driver reports anything. The card names the source and
  says the driver has not confirmed it (checked in code).
- **Autonomy suggestion**: after N unchanged approvals of one kind of action (N = 5; the Demo page can lower it), For you
  offers once: "You approved 5 ferry bookings under €400 unchanged. Let the agent do these without asking?" Yes / Not now.
  Yes sets the policy to automatic up to that cost and logs the change; customer contact and promised delivery dates never
  become automatic.
- **Silent problems** (Monitor rules): a car on the road that does not move (GPS without progress, or no GPS in the recorded
  data) or a pickup slot passing with no collection → the Investigator asks the driver; a driver cancelling a gig → a card
  built by code to republish now, with a fee raise for the time left (≤12 h +30%, ≤24 h +20%, ≤48 h +10%).
- **No reply**: an unanswered `ask_driver`/`ask_site` gets one follow-up after 15 simulated minutes; 30 minutes later the
  run hands it to a person with "Driver not answering since 10:42". The Demo page sets per scenario whether the simulated
  driver answers.
- **One cause, several orders**: one card covers all of them, with each order's effect and one approve action.
- **Prompt injection test**: `npm run eval:injection` (live path and policy layer), filed as an eval case.
