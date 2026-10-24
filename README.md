# The Car Delivery Control Room

This is Bahn's challenge for the Prompt Operations Hackathon, 24 to 25 October
2026.

Bahn delivers used cars. A dealer sells a car, a driver from our network picks
it up and drives it to the buyer. Our agents already do a lot of the routine
work. The challenge is to build the place where people and agents work
together to get every car delivered, and one real agent for one part of the
job.

**Read `PARTICIPANT-BRIEF.md` first.** It says what to build, what to hand in,
and how we judge.

Everything in this repo is made up. No real people, cars, companies or
messages.

## What is in here

- `PARTICIPANT-BRIEF.md`: the challenge. Start here.
- `OPERATIONS-CONTEXT.md`: how car delivery work goes at Bahn, in plain
  words. Good reading for you and for your coding agent.
- `dataset/`: 100 made-up orders and everything around them: dealers,
  drivers, cars, bookings, messages, alerts, documents and events.
  `dataset/README.md` explains the files. `dataset/SCHEMA.md` explains every
  field.
- `attachments/`: made-up documents, receipts and photos that belong to those
  orders.
- `starter/`: the Control Room V3 app (Next.js, Postgres, the Anthropic API):
  For you, Agents, Orders, Settings and the Demo controls. `SPEC.md` describes it.
- `fixtures/`: recorded agent runs and scenario recordings, so the app shows real
  agent output without an API key. `traces/`: one JSON trace per agent run.
- `mockups/`: screenshots of the starter, so you can see it without running
  it.
- `check_packet.py`: a script that checks the data is complete. You do not
  need it, but you can run it with `python3 check_packet.py`.

## Run the control room

You need Node.js 24 or newer and Docker. An Anthropic API key is optional.

```sh
cd starter
cp .env.example .env        # optional: add ANTHROPIC_API_KEY=... to run agents live
npm ci
docker compose up -d --wait
npm run db:push
npm run setup               # dataset, attachments, timeline, alert cards, disruption feed, recorded agent runs
npm run dev
```

Then open http://localhost:3000. Start on **For you**: the cards that need a person, in the order
something is lost. **Agents** shows what every agent did and is doing, **Orders** has all 100 orders,
**Settings** holds what agents may do on their own and the cases they learn from. **Demo controls**
(bottom of the left rail) moves the simulated clock and plays the scenarios.

**Without an API key** the app shows the agent runs recorded in `fixtures/agent-runs.json` (the top bar
says "Showing recorded agent runs"). Approving a card still works: the Executor is code. On the Demo
page, "Replay recorded run" plays back a live run of each scenario at its real speed, marked "Replay".

**With an API key** (check it with `npm run api:check`) agents run live: the Demo page's "Play live",
the search box's "Ask the agents", replies to agent cards, and the Monitor's rules.

| Command | What it does |
|---|---|
| `npm run agents:backfill` | The morning's work: the Classifier reads every message, the Investigator looks into every order with a live signal, the Monitor's rules run, quiet orders get a check by code. Writes `fixtures/`, `traces/` and `fixtures/backfill-report.json`. About 10 minutes and $5. `--resume` finishes a run that stopped |
| `npm run agents:investigate -- CD-420322` | One Investigator run, printed with its card |
| `npm run scenario:record -- scenario-2` | Plays a demo scenario live and records it for replay |
| `npm run monitor` | The Monitor's rules once (`--dry` only lists what the disruption feed matches) |
| `npm run eval:injection` | The prompt-injection test (Settings → Learning shows the result) |
| `npm run fixtures:load` | Back to the recorded morning |
| `npm run case -- CD-420322` | The case file as text (`--agent` shows what the agent reads) |
| `npm run screens -- --both` | Playwright screenshots of the running app (`APP_URL`, default port 3001) |
| `npm run typecheck`, `npm run smoke` | Checks |

If port 5438 or 9009 is already in use on your computer, change it in `starter/compose.yaml` and in
the matching line of `starter/.env`. `SPEC.md` says what is built, `PROCESS-LOG.md` how it was built.

## Tips

- Point your coding agent at `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md`
  and `dataset/SCHEMA.md` before you start. They explain the world better than
  the code does.
- The data is a snapshot. Nothing in it changes by itself. Your agent can
  pretend to send messages, make calls and book things. Nothing real is
  connected.
- Some of the data is messy on purpose. A message can disagree with an
  address. An alert is a reason to look, not a diagnosis. A quote for a ferry
  is not a booked ferry.
- The starter's board of lanes is how people have worked so far. It is not the
  answer.
- Questions: our channel on the event Discord, or our booth.
