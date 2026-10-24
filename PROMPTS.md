# Claude Code prompts

Put `SPEC.md` and `CLAUDE.md` in the repo root (next to PARTICIPANT-BRIEF.md).
Add `ANTHROPIC_API_KEY=...` to `starter/.env`. Start Claude Code in the repo root.

---

## Prompt 1 — foundation (phases 1–3)

```
Read CLAUDE.md, SPEC.md, PARTICIPANT-BRIEF.md, OPERATIONS-CONTEXT.md and dataset/SCHEMA.md.
The app lives in starter/ (Next.js + Drizzle + Postgres, already seeded and running on port 3001).
We are replacing the whole UI with Control Room V3 as described in SPEC.md. Keep the existing
schema, seed and data loading; remove the old board, inbox and entity pages once the new screens
replace them.

Do phases 1, 2 and 3 from SPEC.md section 11, in order. For each phase: implement, run its check,
fix what the check shows, run typecheck, then append an honest entry to PROCESS-LOG.md.

Before writing code, spend a few minutes reading the dataset itself (orders with alerts, work items,
incidents, proposals, messages) so the timeline summaries and consequence sentences fit real records.

When phase 3 is done, stop and give me: a short summary, the Playwright screenshots of For you
and three order pages (CD-420322, CD-420299, CD-420603), and anything in SPEC.md you think is wrong.
```

---

## Prompt 2 — agents (phases 4–6)

```
Continue with phases 4, 5 and 6 from SPEC.md. Same rules: check, fix, typecheck, PROCESS-LOG.md entry per phase.

Write the agent system prompts carefully in lib/agents/prompts/. Test the Investigator on
CD-420322, CD-420299, CD-420593 and CD-420449 and read the cards it produces. If a card is vague,
cites no source, treats a quote as a booking, or uses internal words, fix the prompt or the tools
and run it again. Log what you changed and why.

When phase 6 is done, stop and show me scenario 1 and scenario 2 from SPEC.md section 9 working
(screenshots of each step), plus one full agent trace.
```

---

## Prompt 3 — aquarium, backfill, polish (phases 7–8)

```
Continue with phases 7 and 8 from SPEC.md. Run the backfill over every live-signal order and
export fixtures and traces. Verify a fresh database with no API key still shows recorded runs.

Then polish: empty and loading states, ⌘K search/ask, Settings pages, scenario 5, light and dark
mode. Take Playwright screenshots of every screen in both themes, look at them critically as a
Bahn operations person who has never seen the app, and fix what is unclear or ugly. Update the
README so the app runs from a fresh clone.

Finish with a PROCESS-LOG.md summary section: the five most important decisions we made while
building and where we did not take the first answer.
```
