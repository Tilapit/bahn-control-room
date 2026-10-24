# Rules for coding agents in this repo

Read `SPEC.md` first. It decides what we build. If something in the code disagrees with SPEC.md, SPEC.md wins.
Also read `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md` and `dataset/SCHEMA.md` before touching data code.

## How to work
- Work phase by phase (SPEC.md section 11). Do not start the next phase until the current phase's check passes.
- After each phase, append to `PROCESS-LOG.md`: what you built, how you checked it, what was wrong
  in the first attempt and what you changed, and anything you decided not to do and why. Be specific
  and honest; this log is graded.
- Run `npm run typecheck` before declaring a phase done.
- For UI work, take Playwright screenshots (`scripts/screens.ts`) and look at them before moving on.
- Do not ask questions you can answer from SPEC.md, the brief or the data. Make a sensible choice and log it.

## Product rules (never break)
- The agent never contacts a customer on its own. No such tool exists.
- Any change to a booking, date, cost, or a customer message is a card that needs approval.
  Enforce this in code (policies table), never only in a prompt.
- Every fact shown to a person carries its source and time. No source, not shown.
- A quote is never shown as a booking. An alert is a signal, not a diagnosis.
- Use the simulated clock (`lib/clock.ts`), never `Date.now()` in business logic.
- All data stays fictional.

## LLM vs code
- Code: urgency, deadlines, routing, policies, execution, summaries built from structured fields.
- Haiku: classify and extract from messages, verify cards, narrate runs, simulated driver.
- Sonnet: Investigator and Driver support. Opus: Investigator on safety, cost > €500, or conflicting evidence.
- Model ids only in `lib/models.ts`.

## UI language
English. Ops words: order, car, driver, gig, pickup, delivery, ferry, customer, site.
Never show internal words or ids: assignment, segment, endpoint, enum values, record ids, JSON.
Buttons say exactly what happens: "Approve: book the 18:00 ferry", not "Submit".

## Design
Calm and readable, like Apple Mail or Linear. System font, 15px base, one accent colour,
red only for safety, amber for time risk, light and dark mode. No cards inside cards, no heavy
shadows, few borders. Every page has an empty state and a skeleton loading state.
