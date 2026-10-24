# Process log

How Control Room V3 was built, phase by phase (SPEC.md section 11). Each entry says what was
built, how it was checked, what was wrong in the first attempt, and what was left out on purpose.

---

## Phase 1 — Data layer

**Before writing code** I read the brief, SPEC.md, OPERATIONS-CONTEXT.md, dataset/SCHEMA.md and the
records themselves: all 19 alerts, 15 work items, 4 incidents, 14 agent proposals, 9 internal room
posts, the support inbox, and the full record trail of CD-420322, CD-420299 and CD-420603. I also
computed the spec's "live signal" set with a script. It is **30 orders**, inside the spec's 30–35.
Two things from the data shaped the design:

- Messages have no direction field. Inbound vs. outbound comes from `author_type`.
- Many operational events repeat a record that already exists (`alert.raised` ↔ the alert,
  `travel.booked` ↔ the reservation, `proof.submitted` ↔ the proof). Mapping both would double
  the timeline.

**Built**

- `lib/schema.ts`: the SPEC 5.1 tables (`timeline_entries`, `facts`, `agent_runs`, `agent_steps`,
  `cards`, `decisions`, `policies`, `eval_cases`) plus `demo_events`, `sim_clock` and
  `search_documents` (with a generated `tsvector` and a GIN index). None has a foreign key to a
  starter table, so `npm run db:seed` can still truncate and replace the snapshot. Applied with
  `drizzle-kit push`.
- `lib/clock.ts`: the simulated clock, stored in one DB row so the demo page and every server
  process see the same time. It starts at the snapshot (2026-10-21 09:00 UTC) and only moves
  when told to.
- `lib/timeline/sources.ts`: the source vocabulary (channel → source, labels, filter chips,
  chip text like "Driver · 08:42").
- `lib/timeline/build.ts` + `npm run timeline:build`: one entry per meaningful record, with
  summaries written by code. Messages, support inbox, internal room posts, order notes, GPS,
  bookings, quotes, alerts (and who took or closed them), incidents, tasks, earlier agent
  proposals (with their review and execution), documents, proofs, costs, site visits, terminal
  gate records, driver reports, key tracking, handover details, claims, time windows, and the
  rest of the event log. **2,345 entries, 517 facts, 100 search documents.**
- `lib/case.ts`: `getCase`, `getCases` (batch, for the queue), `timeline(order, since)` and
  `search(query)`.
- `scripts/case.ts` + `npm run case <ref>`: prints the case file as text (`--json` for raw).

**How I checked it**

- `npm run case CD-420322`: the output reads like a handover note. Stage "On the road". Key
  times are picked up, a stale ETA and the delivery promise (Wed 21 Oct 12:00–16:00 CEST,
  "Marvellin Motorhandel, order form"). Facts show the Hamburg gate rule from the site profile,
  and the pickup details are marked historical. Open items are the critical safety stop (taken
  by the Shift lead), an untaken tracking-gap alert, the incident, the recovery task, the
  requested warning-light photo, and the driver's unanswered 08:58 message.
- Also read CD-420299 (ferry: sold-out sailing and €387 quote listed under "QUOTE ONLY", failed
  booking attempt visible), CD-420702 (transfer yard), CD-420089 (driver travel; unlinked
  support message), CD-420603.
- Search: 11 queries (reference, partial reference, plate, make, city, driver, customer, a word
  that only appears in a message, two words, nonsense).
- Ran the build twice: same counts, no duplicates. Typecheck clean.

**What was wrong in the first attempt, and what changed**

1. Message summaries were cut at the first sentence. CD-420322's driver message became "I have
   stopped the Bentley Continental GT on CD-420322." and lost "A red warning came on". Messages
   now keep the whole text up to 240 characters.
2. "Kasper Kovelund accepted the gig" and "Gig booked by Kasper Kovelund" appeared at the same
   minute on every booked order. The offer-accepted event is dropped, and the booking reads
   "Kasper Kovelund took the gig".
3. On CD-420702 the yard release slot (tomorrow) was marked historical, because the car had
   been picked up at the origin. Transfer-yard facts now follow the release from the yard, and
   the yard slot is a key time.
4. The driver's train on CD-420089 printed in UTC. Times now use the city's zone, taken from
   the address records.
5. Search snippets highlighted header fields ("«Bentley» Continental GT 2025 …"), which is
   noise. The document now separates header fields from message text, and a snippet only shows
   when the match is inside a message.
6. "routing-service" showed as "Routing-service". System actors now have names
   ("Alert routing").
7. `lib/db.ts` imported `server-only`, so no script could import it. Removed. No client
   component imports `lib/`.

**Decisions and things left out**

- Timeline ids are deterministic (`messages:msg-…`, `alerts:alert-…:ack`). Facts and later
  cards point at entries, so a rebuild must not change ids. A rebuild deletes only
  `origin = 'dataset'` rows; entries written live by agents and decisions survive it.
- Added a few columns the spec does not list: `origin` (timeline, facts, cards), `language`,
  `next_check_at` on runs (the Agents view shows it), `decided_count` on policies (for "14 of
  15 times"), `undone_at` on decisions (undo).
- Support inbox messages are filed under an order only when the link is confirmed. Candidate
  matches appear in the case file as "unlinked support message may concern this order" and
  never on the order's timeline. The customer email that quotes CD-420089 from another account
  stays unlinked, as SCHEMA.md asks.
- The 517 facts in this phase are derived by code from structured records: handover
  instructions, contacts, handover claims, selected slots and promises. Agreements made in
  messages need the Classifier (phase 6). Until then, CD-420322's "customer asked to keep the
  car stopped" is on the timeline but not in "Agreed".
- `site_chat` has no source in the spec; it maps to support. I added an "Alerts" filter chip,
  because the spec's chip list has no place for alerts.
- Left out: the 161 offer view/pass signals and the reach checks. They are dispatch telemetry,
  not things a person reads on an order timeline.
- The clock does not tick by itself. A ticking clock would leave "check-in closes in 3 h"
  wrong after a coffee break. The demo page will move it explicitly.

---

## Phase 2 — Urgency and the For you list

**Built**

- `lib/urgency.ts` (code only): the next moment something is lost, as a sentence against the
  simulated clock, plus the queue order (safety first, then earliest consequence, "no deadline"
  last). `npm run urgency` prints every live-signal order in queue order.
- `lib/signals.ts`: the spec's "live signal" test in code (30 orders).
- `lib/cards/from-alerts.ts` + `npm run cards:alerts [-- --reset]`: 17 temporary cards, one per
  order with an open or taken alert. Each has a headline (car + what happened), what happened,
  findings that cite timeline entries, and the next step already recorded by people or earlier
  agents, with its source.
- `lib/queue.ts`, `lib/decisions.ts`, `POST /api/cards/:id/decision`,
  `POST /api/decisions/:id/undo`, `GET /api/search`.
- New design system (`app/globals.css`, light and dark tokens), app shell (rail with the open
  count, ⌘K search with message snippets, simulated clock), the For you page (expand in place,
  undo toast, empty state, skeleton loading).
- `scripts/screens.ts` + `npm run screens` (Playwright 1.64.1; it matches the browser already
  in the local cache, so nothing extra was downloaded).

**How I checked it**

- `npm run urgency`: CD-420322 (safety) first. Then the missed pickup on CD-420593, the ill
  driver's train on CD-420449 ("Driver's train from Aalborg leaves in 1 h 25 min, at 12:25"),
  the yard delay on CD-420702 ("Customer was promised delivery in Espoo by today 14:00"), and the
  ferry on CD-420603 ("Ferry check-in in Hamburg closes in 3 h, at 14:00"). I read the sentence
  for every one of the 30 orders.
- Screenshots of For you, collapsed and expanded, plus the empty state and search. I looked at
  each and fixed what is listed below.
- Browser test with Playwright: expand the last card, Mark as handled → row gone, rail count
  17 → 16, toast; Undo → row back, count 17. API: deciding twice returns 409. The decision
  appears on the order's timeline as an Ops entry and disappears on undo.

**What was wrong in the first attempt, and what changed**

1. Sentences said "(Berlin time)" for a delivery in Hamburg. They now name the place: "Customer
   was promised delivery in Hamburg by today 16:00".
2. "Pickup in Helsinki slot ended 1 h ago": fixed the word order.
3. The ill driver's train printed in UTC: Aalborg is not in the address records. It now falls
   back to the pickup's zone, which is where positioning travel heads.
4. The alert fallback sentence said "look at it by 17:12". That invents a deadline with no time
   zone. Now: "No deadline in the records; alert raised 2 h 48 min ago". The spec's +2 h / +8 h
   still sorts fresh alerts. An expired fallback now sorts last instead of first. Otherwise
   Monday's missing-signature alert (CD-420164) would sort above a ferry check-in that closes
   in 3 hours.
5. The first screenshot had 17 blue "Mark as handled" buttons: loud, and none of them a real
   decision. A code-built card holds no decision, so its buttons now appear only when the card
   is open, and not in blue. Blue is kept for agent proposals that need approval. The one-line
   clamp on the next step was broken by an inline style. The first finding repeated "What
   happened" word for word.
6. The rail's grey background ended at viewport height in full-page screenshots.
7. **Stale dev server.** The decision API returned 500 with `Symbol(drizzle:Columns)`. The
   running dev server log showed `searchDocuments` interpolating as nothing. A debug route
   listing the schema module's exports showed only the 13 starter tables. Turbopack had missed
   the change to `lib/schema.ts` for the API-route layer (I had edited it with `sed -i`, which
   swaps the file). Restarted the dev server on port 3001 with a clean `.next` cache.
   Lesson: edit files in place, not with `sed -i`.
8. The empty state left out the counts the spec asks for.

**Decisions and things left out**

- The header says "agents are handling N" only for orders that have an agent run. There are
  none yet, so it reads "17 need you · 13 more with open items, no agent run yet · nothing open
  on 70" rather than claiming work that is not happening. I also used "nothing open on 70"
  instead of the spec's "moving normally": 21 of those orders are delivered and 12 are new
  intake.
- Additions to the urgency rule, all from the data. A missed pickup slot or promise counts as
  already lost (sorts first). Booked driver travel counts when the driver is the problem. A
  proposed but unselected pickup slot counts for intake orders ("Planned pickup in Hamburg on
  Mon 26 Oct 10:00 is not confirmed yet").
- Time risk (amber) means missed, or due within 4 hours. Red only means safety.
- Temporary cards propose nothing new. Their only button is "Mark as handled", which records a
  decision and a timeline entry and can be undone. Nothing is executed until the Executor
  exists (phase 5).
- Chip times use the order's place: the pickup zone until the car is collected, then the
  delivery zone. The top-bar clock shows Helsinki time for the desk. Every time shows the
  absolute value and zone on hover.

---

## Phase 3 — Order (case) view

**Built**

- `/orders/[reference]`: one-line status (what is wrong, then what is lost next, built by
  `lib/status.ts`), car, route, driver, customer. Below that, two columns:
  - Main column: the open card ("Needs you", the same card as in For you, opened) or, with
    no card, an "Open on this order" list. Then the full timeline with source filter chips
    (All, Driver, Support, Internal, Email, GPS, Bookings, Alerts, Agents, People), grouped by
    day, newest first. Consecutive GPS positions fold together. Every entry shows who, the
    source and the time.
  - Side panel: Key times with sources, Agreed (facts and agreements with source and time;
    pre-handover details folded away), and Route and travel ("Booked", "Booking lost",
    "Quote, not booked", "Sold out").
- Every source chip on a card or fact links to its timeline entry (`#entry-id`). The page
  scrolls to it, opens a folded GPS run if needed, and highlights it.
- Words that keep evidence honest, on the entries themselves: "Signal, not a diagnosis" on
  alerts, "Quote, not booked", "Estimate, not a position" for the ferry-timetable inference,
  "Stated, not confirmed" vs. "Confirmed" on facts, "arrived 25 min later" when an upload was
  delayed.
- `/orders`: all 100 orders, open ones first in queue order, with a filter. `/agents` and
  `/settings` have honest empty states until their phases. Loading skeletons and a not-found
  page for unknown references.
- Removed the starter's board, inbox, customer, driver and site pages, the old order record,
  their APIs (`/api/overview`, `/api/orders/:id`, `/api/entities`, `/api/inbox`) and the
  present-layer files only they used. Kept the attachment and reference-data routes. Rewrote
  `npm run smoke` for the new screens.

**How I checked it**

- Playwright screenshots of CD-420322, CD-420299 and CD-420603, full page and first screen,
  light (and CD-420322 dark). I read each one and fixed what is listed below.
- `npm run smoke`: For you renders, **all 100 order pages render** with their timeline, and
  search finds orders by reference and by message text.
- Browser test: on CD-420164, Mark as handled folds the card into "Marked as handled. Undo";
  Undo brings it back. A GPS chip on CD-420322's card scrolls to the right timeline entry and
  shows it. The Driver filter shows 5 entries. An unknown reference shows the not-found page.
- Typecheck clean.

**What was wrong in the first attempt, and what changed**

1. The card on the order page repeated the page header word for word (headline and promise
   twice). On the order page the card now shows only its body under "Needs you".
2. The delivery promise appeared in both Key times and Agreed. Slots and promises now live
   only under Key times, with the same source.
3. The CD-420603 card said "Review ferry cutoff for CD-420603; source is a conversation, not a
   verified outcome". That is the dataset's internal alert wording, not what happened. For
   alerts raised from a conversation, the card now quotes the message that raised it: "Ferry
   check-in at risk, raised from a message by the driver, Charlotte Benvik: 'The queue before
   the terminal has barely moved…' The alert is a signal, not a verified outcome."
4. The sold-out sailing on CD-420299 carried a "Quote, not booked" chip. A sold-out check has
   no price, so it is not a quote. It is now an "Availability check".
5. The sticky side panel was taller than the screen, so "Route and travel" could not be
   reached on busy orders. It now scrolls on its own.
6. Deciding on the order page refreshed the page, which removed the card together with its
   undo toast. Now the card folds into one line with Undo, and the page refreshes after the
   undo window.
7. "Internal (Slack) · Internal" said the same thing twice. Also removed: "No plate recorded"
   (a wasted line on most orders), "Selected by Ops" next to a chip that already said it,
   and an explanatory hint under "Agreed".
8. On the Orders list the whole consequence sentence was coloured red or amber. Across 100
   rows that was loud, so it is plain text now, with a severity dot.
9. Chip times are local to the order (Hamburg before pickup, Lahti after), while the ferry key
   time is Hamburg time. The key times name their zone; the timeline header now says
   "times in Lahti time".

**Decisions and things left out**

- Two columns on wide screens (timeline left, facts right), one column under 1100 px. The
  spec's top-to-bottom order is kept in the narrow layout.
- The car picture is the starter's model illustration. Its hover text says it is not a photo
  of this car.
- "Agreed" for now holds only facts that code can derive: handover instructions and contacts
  (confirmed or stated), and verified or open handover claims. Agreements made in chat ("keep
  the vehicle stopped") need the Classifier (phase 6). The timeline already shows them.
- Not built yet, on purpose: the ⌘K "ask a question" mode, the Agents view and Settings
  content (phases 7–8). Attachments (photos, PDFs) are not shown on the order page yet; the
  starter's attachment route is kept for that.
- Spec gaps found while building are in the next section.

---

## After phase 3 — nine corrections to SPEC.md

After phase 3 I listed what I think SPEC.md gets wrong. The person I work with checked
corrections 1, 2 and 9 against the data themselves and accepted all nine. SPEC.md now includes
them, plus the decisions below.

1. **Scenario 2 said "tomorrow's delivery will be late".** CD-420322's delivery promise is
   today, Wed 21 Oct 12:00–16:00 CEST in Hamburg (the snapshot day). The card says "today".
2. **Scenario 1 would have booked the ferry twice.** The earlier booking attempt timed out
   without a confirmation, and the data's own pending proposal says to check that outcome
   before retrying. The agent now reconciles first. The next sailing (Sat 24 Oct 14:00 CEST)
   still arrives before the 27 Oct promise, so the customer promise stays unchanged.
3. **The urgency rule did not fit the data.** It used only ferry cutoffs on reservations, but
   CD-420299 has no reservation (only a quote and a sold-out check). It had no case for a time
   already missed (CD-420593's pickup slot) or for the driver's booked travel (CD-420449's
   train). And "triggered + 2 h / 8 h" pushed Monday's alert above a ferry closing in 3 hours.
   SPEC section 6 now has the extended rule that phase 2 implemented.
4. **The header counts did not match the data.** "5 need you · agents are handling 31 · 64
   moving normally" implies 36 orders with something open; the data has 30. "Moving
   normally" is wrong for delivered, cancelled and new orders. "Agents are handling" now
   counts only orders with an agent run; the last part reads "nothing open on N".
5. **Scenario 5 assumed map positions.** Tracking has no coordinates. Decision: the authored
   deviation is km to go increasing, plus a driver message naming a city.
6. **The source mapping and filter chips had gaps.** `site_chat` → support; customer and
   operator order notes are mapped too; an "Alerts" filter chip was added (calls sit under
   Support).
7. **"The site's time zone" was ambiguous** for an order that touches a pickup site, a delivery
   site and a ferry terminal. Rule: key times use their own place's zone, with the zone name;
   the timeline uses the pickup zone until the car is collected, then the delivery zone, and
   says which.
8. **Undo and execution would clash.** Decision: an approved action is executed only after an
   8-second undo window ("Booking in 8 s · Undo"). Undo inside the window cancels it; after
   it, the Executor runs.
9. **CD-420603 has conflicting evidence.** The driver says "in the queue before the
   terminal", but the last GPS shows 1,772 km to go, about 160 km short of the Hamburg
   terminal. Decision: this is an Investigator test case. The driver's words are a claim, and
   the card must show the gap between them and the GPS.

Also added to SPEC.md for phase 4:
- Prompt caching on the system prompts and the tool definitions.
- `get_case` as compact text: about 2,000 tokens, one line per entry with its source and time.
- Investigator step cap of 12, with truncated tool results.
- Tokens and cost stored per run and shown in the Agents view.

SPEC.md 5.1 now also lists the columns and tables phases 1–3 added (`origin`, `language`,
`next_check_at`, `decided_count`, `undone_at`, `demo_events`, `sim_clock`,
`search_documents`), so the spec and the code agree. The cost columns on `agent_runs`
(`cache_read_tokens`, `cache_write_tokens`, `cost_usd`) are specified for phase 4 and are not
in the schema yet.

---

## Phase 4 — Agents

**Built**

- `lib/models.ts`: the three model ids with their prices (input, output, cache read, cache write). Cost is computed
  per model call from the usage the API returns, priced by the model that actually answered, and added to the run.
- `lib/policies.ts`: the permission table, seeded into `policies` (21 actions) and enforced in code. Reading, asking
  and look-ups are automatic; bookings, cost, dates and customer contact need approval. An unknown action is never
  allowed. Customer contact can never be set to automatic, whatever the table says.
- `lib/agents/`:
  - `case-text.ts` + `refs.ts`: `get_case` as compact text, one line per item with source and time.
  - `tools.ts` (14 tools), `mocks.ts`: ferry line, hotels, trains, repair shops, driver pool. The mocks are
    deterministic and seeded from the dataset's quotes, sold-out checks, reservations and drivers.
  - `investigator.ts`: the manual loop. Step cap 12; tool results cut at 8,000 characters (the full result stays in
    `agent_steps`); prompt caching on the system prompt, the tool definitions and the growing conversation; pause
    and resume on questions.
  - `propose.ts`: code checks, then the Verifier, then the card. `verifier.ts`: Haiku, JSON output.
  - `sim.ts` + `scenarios.ts`: the simulated driver and site (Haiku), with a fictional note per test order so
    replies are consistent.
  - `runs.ts`: runs, steps, tokens, cost, and a trace file per run in `traces/`.
  - `prompts/investigator.md`, `verifier.md`, `simulated-party.md`.
- Every look-up writes a timeline entry: "Ferry line lookup", "Quote, not booked", "Repair shop lookup". That way a
  card can cite what the agent found, and a person can see on the timeline what the agent did.
- `timeline:build` writes the terminal planning estimates (a dataset collection that had no timeline entry) as
  citable entries, with the route's length.
- `npm run agents:investigate -- CD-… [--fresh]` runs one order and prints the card. `npm run case -- CD-… --agent`
  prints exactly what the agent reads.
- UI: agent cards in For you and on the order page. They show findings with source chips, the verifier's result,
  the exact email, call script or driver message being approved, the cost and the reason approval is needed, the
  other choices with their effects, and one quiet line: "Investigated by the agent · Opus · 7 steps · 41k tokens ·
  $0.16".

**How I checked it**

About 20 Investigator runs on CD-420322, CD-420299, CD-420603, CD-420593 and CD-420449. I read every card and every
verifier note, and the steps when a card was wrong. Final pass, all five with the finished prompts:

| Order | Model (why) | Steps | Cost | Card |
|---|---|---|---|---|
| CD-420299 | Opus (proposal €511 > €500) | 9 | $0.27 | Ferry line lookup first ("the timed-out request created no booking, nothing charged"), then a re-check: Sat 00:00 sold out, Sat 14:00 €387 quote. Proposes ferry + Hamburg hotel; "the Tue 27 Oct promise still holds, the customer needs no message". All 7 facts pass the verifier. |
| CD-420322 | Opus (safety) | 7 | $0.16 | Asks the driver for safety, place and photo; recovery quotes; "today's delivery, promised in Hamburg by 16:00 CEST, will be late"; the driver's place labelled as their report next to the stale GPS; proposes a call to the dealer with the script shown. Books no tow, because the dealer asked to keep the car stopped. |
| CD-420603 | Opus (conflicting evidence) | 10 | $0.22 | Both "queue before the terminal" messages with times, "GPS at 11:06 EEST: 1,772 km to go on the 2,391 km route … roughly 181 km short", the driver's answer when asked. Keeps the booked crossing. |
| CD-420593 | Opus (customer's system vs site desk) | 8 | $0.18 | Asks the site: the car is at the Vantaa yard, released from 13:00 once the customer confirms. Proposes a call to the customer and sending the driver to Vantaa. |
| CD-420449 | Sonnet | 7 | $0.11 | Asks the driver (fever, doctor says rest), finds three Hamburg drivers who have not been asked. Proposes offering the gig to one; the current driver is released only when the new one accepts. |

Caching works: CD-420299 read 98k tokens from cache against 10k uncached input. Typecheck clean; `npm run smoke`
passes (all 100 order pages). Screenshot of For you with agent cards, looked at; see the last item below.

**What was wrong in the first attempts, and what changed**

1. **`get_case` was 4,000–4,800 tokens**, twice the target. A full entry id costs about 20 tokens and there are
   ~60 per case. The agent now reads short per-run handles (`[E12]`). Code maps them back to entry ids, so the agent
   can only cite what it was shown. Runs of GPS positions keep the newest three, and stage-change events are left
   out. Now 2,200–3,300 tokens. Still over 2,000; the rest is the timeline itself, which the agent needs.
2. **The ferry mock listed the same sailing twice** (`…T22:00:00Z` vs `…T22:00:00.000Z` as map keys). The agent saw
   €387 and €499 for the Saturday sailing and wrote a confused finding about it. Keys are normalised.
3. **The Verifier's false alarms.** (a) It got only the body of a quote entry, which lacks the price, and flagged a
   true €387 claim. It now gets summary and body. (b) It read internal step names as text the person sees; it now
   gets plain words and is told what the person sees. (c) It called km-to-go arithmetic "treating GPS as a position",
   and read the app's ETA (for Lahti) as a terminal ETA. The case text and the Verifier now say the ETA is for the
   delivery address, and that arithmetic is allowed when it is presented as an estimate.
4. **The agent guessed a pronoun** ("she has not changed her pickup time"). The prompt now says: name or role, and
   they/them when a pronoun is needed.
5. **Every first `propose` call arrived malformed**: `"findings": "\n<parameter name=\"findings\">[]"`, no options,
   reject label "x". I tried `strict: true`. It fixed the shape but garbled the text: literal `–` escapes, and a
   finding that swallowed its own `"source"` key ("…EET, essource"). Strict on all tools was also refused ("Schema is
   too complex"). I reverted. Code now recognises the malformed call and sends one clear instruction back; the agent
   always recovers on the next step. It costs one step (about a cent). I kept that over garbled text on a card.
6. **CD-420322 was closed without a card.** My first resolve rule said "someone already owns the next step", so Opus
   reasoned "the Shift lead owns the task" and closed a safety case. The rule now says a decision that needs a
   person is a card, even when a desk owns the task. Code refuses `resolve` on any safety case, and caps the resolve
   summary at one sentence (the first was a paragraph).
7. **CD-420603 never reached Opus.** Sonnet noticed the conflict in its own thinking but did not call `escalate`.
   When it asked the driver and got an answer, the original disagreement vanished from the card, so the Verifier
   (which saw only cited records) had nothing to flag. The Verifier now also gets the driver's messages from the
   last 12 hours, the last GPS and the terminal estimate, and reports `sources_conflict`. Code then hands the run to
   Opus and requires both statements and the gap on the card. With a stronger prompt, Sonnet now often escalates
   by itself; the code check is the backstop.
8. **The Verifier crashed on cut-off JSON.** Haiku's thinking used up the 3,000-token limit. The limit is now 16,000,
   `max_tokens` is checked explicitly, and a Verifier failure annotates the card instead of stopping the run.
9. **Mixed time zones** ("10:31 EEST", "11:02 Hamburg time", "14:00 CEST"). Part of it was my bug: the simulated
   reply's time was formatted in the pickup zone while the timeline uses the delivery zone. Fixed; and the prompt
   asks for the zone after every time, as printed.
10. **CD-420593 asked nobody.** It proposed "keep collection paused, check again in 120 minutes", and after escalation
    my hand-off text ("call propose again") steered Opus straight to another card. The prompt now asks one question
    before every proposal: would a question to the driver or site change it? The hand-off now invites asking first.
    The next run asked the site and learned where the car is.
11. **A mock misled the agent.** My fallback timetable gave Helsinki → Vantaa (about 20 km) a 4-hour train at 15:00,
    so the agent concluded the driver could not get there and proposed sending them home. The travel mock now
    knows rough distances between the dataset's cities, runs local trains every 20 minutes and offers a taxi for
    short hops.
12. **Six findings was too few.** Three runs dropped something essential (the promise, the hotel, the planning
    distance) to fit, and the Verifier flagged the gap each time. The limit is now seven, and `what_happened` is
    capped at about two sentences in code.
13. **A second ferry booking.** One CD-420603 option booked another crossing beside the active one. Code now rejects
    `book_ferry` on a car with a booked crossing and asks for `change_ferry_booking`.
14. **The gap needed two sources.** "GPS 1,772 km to go vs ~800 km to the terminal" combines two records, and the
    route length had no record at all. The planning-estimate entry now states the route length, and a finding may
    cite a second source (`also`).
15. **A dropped network connection killed a run.** The SDK now retries 4 times; after that the run is marked failed
    with its conversation kept.
16. **The For you rows were a wall of buttons** (three long labels on every collapsed row), and "Agent proposes:"
    repeated the blue button word for word. Collapsed rows now show the proposal button and "N more choices"; the
    line shows what the proposal does.

**Decisions and things left out**

- Three ways to the senior model, all ending in code: the Router picks Opus for safety; the agent can `escalate`;
  the Verifier's conflict check moves the run; a proposal over €500 moves it. The €500 is the total of the
  looked-up prices, not the number the model wrote.
- I built the simulated driver now, not in phase 6, because `ask_driver` needs a reply to test phase 4. Each
  simulated reply moves the simulated clock 2 minutes, so the timeline reads like a real exchange. Replies are
  stored as demo events and marked simulated.
- Short handles instead of entry ids on each line: a deviation from SPEC 7's wording, for the same goal (every
  finding cites an entry), at half the tokens.
- The Verifier may send a card back twice. Notes still failing after that go on the card in amber, so the person
  sees what was not confirmed instead of a silently "clean" card.
- The spec says CD-420603 is "about 160 km short"; the data's planning estimate (Munich to the terminal about
  800 km) gives about 181 km. The card uses the data.
- Server-side refusal fallback (`fallbacks: "default"`) is on for the Opus and Sonnet calls.
- New actions not in the spec list: `message_driver` (automatic: drivers are not customers), `call_contact` (a
  person calls a seller or site), `note` (keep the plan, check again).
- Commit note: this commit also contains groundwork for phases 5 and 6 (decision columns, executor, router, demo
  page) that the card UI already depends on. Those are checked and logged in their own phases.
