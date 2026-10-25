# Demo footage: shot list

Recorded with `npm run footage` (Playwright, 1440×900, light theme) against the app with scale mode on (1,000 orders), starting from the recorded morning. Times in each list are from the start of the clip. Scenario 2 and 7 replay recorded live runs at their real speed: the waiting is real agent time, so cut it in the edit. The blue circle is the pointer, drawn by the page because a recording has none.

## For you, with 1,000 orders

`01-for-you-1000-orders.webm` · 0:41 · 1440×900

Scale mode is on: the dataset's 100 orders plus 900 synthetic quiet copies. For you still holds only the cards that need a person, in the order something is lost, and the header counts the rest.

- 0:02 For you opens: the header counts what needs a person, what agents are handling, and the orders with nothing open
- 0:07 The safety case is first, then the earliest consequence
- 0:11 Scrolling the list: each row says what is lost and when, and what the agent proposes
- 0:24 Orders: all 1,000, the ones with something open first
- 0:32 Search finds any of them by plate, name, city or anything said in a message

## Scenario 1: ferry sold out, approve with undo

`02-scenario-1-ferry-sold-out.webm` · 1:10 · 1440×900

CD-420299. The agent first checked the timed-out booking with the ferry line, then re-checked the quote and proposes the Sat 24 Oct 14:00 sailing and a hotel. Approve, undo inside the 8 seconds, approve again; the Executor books it (simulated) and the order shows it.

- 0:03 The ferry card in For you: what is lost and when, and the proposal in one line
- 0:07 Opened: what happened, what the agent found with a source for each fact, and what it proposes
- 0:24 Approve: the toast counts down the 8-second undo window
- 0:28 Undo inside the window: nothing was booked and the card comes back
- 0:33 Approve again and let the window run out
- 0:45 Booked. The order shows the ferry and the hotel as booked, and the Executor's entries on the timeline

## Scenario 2: red warning light (replay of a live run)

`03-scenario-2-red-warning-light-replay.webm` · 3:15 · 1440×900

CD-420322, played back from a recorded live run at its real speed: the driver's message, the Classifier, the Investigator on Opus asking the driver if they are safe and where, the simulated driver's answer, recovery look-ups, and the safety card. Then a person replies "call the seller first" and the agent continues live.

- 0:02 Demo controls: replay the recorded live run of scenario 2
- 0:07 The driver's phone: the message about the red warning light
- 0:14 Agents: the Investigator works (on Opus, a safety case); the row moves with each step
- 2:24 It asked the driver and waits for the answer
- 2:48 The card is ready: it waits for a person
- 2:50 The safety card is first in For you
- 2:56 What the driver said, the stale GPS, the customer's instruction, the promise, and the recovery quotes, each with its source

## Scenario 6: the driver's words against the GPS

`04-scenario-6-conflicting-evidence.webm` · 0:51 · 1440×900

CD-420603. The driver says they are in the queue before the terminal; the last GPS shows 1,772 km to go. The Verifier found the conflict and code moved the case to Opus. The card shows both statements with their sources and the gap, and keeps the booked crossing. The source chips open the records.

- 0:02 The ferry check-in card: closes at 14:00 Hamburg time
- 0:07 Both statements, with their sources: the driver's messages and the GPS, and the gap between them
- 0:26 The quiet line: investigated on Opus, moved to the senior model because records disagree
- 0:31 A source chip opens the GPS record on the order's timeline
- 0:40 The driver's message chip opens what the driver wrote, with the time

## Scenario 7: a rail strike and a protest near Lille

`05-scenario-7-strike-and-lille-protest.webm` · 2:27 · 1440×900

Two disruption notices, noticed before any driver says anything. The rail strike card (CD-420123) cites the rail operator's notice and says the driver has not confirmed it. Then the Lille protest is published on the Demo page and replayed: one card covers both orders it touches.

- 0:03 The rail strike card: the Monitor matched the notice to the driver's booked train
- 0:08 It cites the rail operator's notice and says nobody on the ground has confirmed it
- 0:25 Demo controls: the regional traffic service publishes a protest notice near Lille (a replay of the recorded live run)
- 0:35 Agents: one Investigator run for both orders
- 2:08 One card, two orders, one cause: each order's effect, and the source

## Autonomy grows: the suggestion after unchanged approvals

`06-autonomy-suggestion.webm` · 1:13 · 1440×900

The Demo page lowers the suggestion threshold to 2. Two ferry cards approved as proposed (CD-420299 and CD-420154); For you then offers once to let the agent book ferries under that cost without asking. Yes changes the permission and logs who and why. Customer contact can never become automatic.

- 0:02 Demo controls: suggest autonomy after 2 unchanged approvals (5 by default)
- 0:08 Approve the ferry card as proposed (BMW M4)
- 0:25 Approve the ferry card as proposed (Audi Q8 e-tron)
- 0:43 For you offers once: let the agent book these without asking, up to the highest approved cost
- 0:49 Yes: the permission changes, and the change is logged
- 0:56 Agent permissions: the ferry booking is now automatic up to that cost; customer contact stays locked

## The order page: one timeline, every fact with its source

`07-case-view-with-sources.webm` · 0:53 · 1440×900

CD-420322. The status sentence, key times each with its source and zone, what was agreed (stated or confirmed), the open card, and the one timeline across driver chat, support, email, GPS, internal notes, bookings and agents, with filters. Times are absolute on hover.

- 0:02 The header: what is wrong and what is lost next, the car, route, driver and customer
- 0:08 Key times, each in its own place's time zone, each with the record it comes from
- 0:13 Agreed: what people said, marked stated or confirmed, with the source and time
- 0:19 The timeline: every channel on one order, newest first
- 0:23 Filter: Driver
- 0:28 Filter: GPS
- 0:33 Filter: Internal
- 0:37 Filter: All
- 0:42 Hover a time for the full date and zone

## How it works

`08-how-it-works.webm` · 0:56 · 1440×900

Settings → How it works, for an operations manager: the flow from a message to a decision, where each kind of information comes from now and in production, which model does which job and why, what agents may do alone, and the numbers measured on the recorded morning.

- 0:01 Settings → How it works
- 0:05 The flow: message or signal, Classifier, urgency and routing in code, Investigator, Verifier, For you, a person, Executor
- 0:21 Where the information comes from, today and in production
- 0:29 Who does which job, and why
- 0:37 What the agent may do alone, and what needs a person's yes
- 0:44 Measured on the recorded morning: runs, model mix, cost and time

## Take over: I'll handle this, then hand back

`09-take-over.webm` · 0:49 · 1440×900

CD-420593, the car that is not at the Helsinki pickup. From its card the person takes the order over: it moves to Yours at the top of For you, no agent or Monitor rule acts on it, and what the agent found stays. They write what they did, which goes on the order's timeline, and hand it back; the agent continues with their note.

- 0:02 A card under Now: the car is not at the Helsinki pickup
- 0:11 I'll handle this: the order is yours, and agents and Monitor rules stop acting on it
- 0:15 Yours, first on For you, with everything the agent found
- 0:20 What the person did goes on the order's timeline, in their name
- 0:32 Hand back to agent: the agent continues from the note
- 0:38 On the order: the takeover, the note and the hand-back, each by the person, on one timeline
