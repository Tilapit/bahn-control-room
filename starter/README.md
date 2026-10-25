# Control Room app

The app itself: Next.js (App Router), Postgres through Drizzle, a local S3 store for attachments, and
the Anthropic API for the agents. The repository's [README](../README.md) says what it is and how to
start it from a fresh clone; [`SPEC.md`](../SPEC.md) says what is built and
[`PROCESS-LOG.md`](../PROCESS-LOG.md) how.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Dataset, attachments, timeline, alert cards, disruption feed and the recorded agent runs, into an empty database |
| `npm run dev` | The app (the screenshot and footage scripts expect port 3001: `npm run dev -- -p 3001`) |
| `npm test` | Unit tests, then the evals on the recorded runs (no API key needed) |
| `npm run evals [-- --live]` | The eval cases and prompt-injection checks, on recorded runs or on the live models |
| `npm run eval:injection` | The prompt-injection test alone; its result shows on Settings → Learning |
| `npm run fixtures:load` | Back to the recorded morning (also resets the demo's switches and disruption feed) |
| `npm run fixtures:export` | Write the current live work to `fixtures/agent-runs.json` |
| `npm run seed:scale [-- --off \| --dry]` | Scale mode: 900 synthetic quiet orders, 1,000 in all |
| `npm run agents:backfill` | The morning's work, live: Classifier, Investigator, Monitor, quiet checks; writes `fixtures/` and `traces/` (about 10 minutes and $5) |
| `npm run agents:investigate -- CD-420322` | One Investigator run, printed with its card |
| `npm run scenario:record -- scenario-2` | Play a demo scenario live and record it for replay |
| `npm run monitor [-- --dry]` | The Monitor's rules once |
| `npm run quiet:lines` | Rewrite the recorded quiet checks after a wording change |
| `npm run case -- CD-420322` | One order's case file as text (`--agent`: what the agent reads) |
| `npm run screens -- --both [--slices 6]` | Playwright screenshots of every page into `../screens` |
| `npm run footage` | Playwright videos of the scenarios into `../demo-footage` |
| `npm run typecheck`, `npm run smoke` | Types; For you, every order page and search against a running app |

## Where things are

- `app/`: the pages (For you, Agents, Orders, Settings with How it works, Demo) and the API routes.
- `lib/case.ts`: one case file per order, the read model the pages, agents and evals share.
- `lib/urgency.ts`, `lib/router.ts`, `lib/monitor.ts`, `lib/policies.ts`, `lib/executor.ts`,
  `lib/decisions.ts`: what code decides and does.
- `lib/agents/`: the Classifier, Investigator, Verifier, Driver support, Narrator and Ask, their tools
  and prompts (`lib/agents/prompts/`). Model ids live only in `lib/models.ts`.
- `lib/scale.ts`, `lib/evals.ts`, `lib/how-it-works.ts`: scale mode, the eval cases, the numbers on
  How it works.
- `scripts/`: the commands above. `tests/`: the unit tests.

The database is replaced by `npm run db:seed` after checking every manifest count; keep your own
tables separate. The attachment store runs at http://127.0.0.1:9009 (console on 9010, credentials in
`.env.example`, local and fictional only).
