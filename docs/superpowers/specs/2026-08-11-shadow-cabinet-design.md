# Shadow Cabinet — Design Spec

## Problem

The CEO of a company needs a way to stress test business decisions against
multiple points of view before acting. Today that means either scheduling
time with real executives, or talking to a single generic AI chatbot that
gives one flat answer with no pushback. Neither is fast enough for quick
decisions, and a single chatbot in particular has no way to represent
competing priorities, financial discipline versus growth investment, for
example, the way a real leadership team naturally does.

## Goal

Build a working prototype where a CEO can pose a business question and get
one clear answer, arrived at by four distinct executive personas who each
reason from their own priorities, argue it out among themselves, ask the
CEO for anything they are missing, and ground every figure they cite in
real uploaded numbers. The CEO gets a decision, not a pile of opinions, and
can open up the debate that produced it whenever they want to check the
reasoning.

## Personas

- **CFO** — financial discipline, P&L, margins, cash flow, risk
- **CMO** — brand, demand generation, customer acquisition, market share
- **COO** — operations, execution, efficiency
- **CSO** — competitive strategy, market positioning, long term bets

No CTO or CRO added for this prototype. Scope stays at four to keep the
debate readable and to leave time for the orchestration and grounding work,
which matter more to this evaluation than persona count.

A fifth agent, the **chair**, facilitates. It is not a board member: it has
no lens, takes no position, and never participates in the debate. It only
closes the session, and is described under Proposed Approach.

## Proposed Approach

Each persona is a distinct Mastra agent with its own system prompt. Persona
voice is kept distinct by those instructions, not by memory isolation. All
four agents share one board level thread ID, which in Mastra means they
share one memory scope: every agent sees the same CEO question and the same
debate history rather than reasoning in isolation. Distinct instructions
plus shared transcript is the whole architecture.

Debate happens in exactly three rounds, closed by a chair. Three is a hard
limit, not a starting point, so a disagreement cannot loop without
resolution.

**Round one.** The CEO's question goes to all four agents concurrently. Each
responds using its own persona and the grounding data it pulls itself. The
shared thread means each agent sees the full history of *earlier* turns,
but because round one runs concurrently no agent sees its siblings' round
one replies while writing its own. Four genuinely independent positions land
instead of three agents converging on whoever answered first.

All four are asked every time. No router decides which personas are
"relevant" — with a board this small, a routing step adds a failure mode
and a round trip to save one paragraph, and an agent with nothing to add
can say so in one line.

Round one is also the only round where an agent may stop and ask the CEO a
question, described under The CEO Interrupt below.

**Round two.** Every round one agent is shown the others' replies and returns
structured output rather than prose:

```ts
{ disagrees: boolean, with: PersonaId[], statement: string }
```

Only entries with `disagrees: true` appear in the debate transcript. The
agent itself decides whether it has a real objection, which needs no
separate judge model and no keyword heuristic, and the boolean makes the
decision inspectable in the stored thread. This is what produces CFO pushing
back on CMO's spend request instead of four agents answering past each other.

**Round three.** Right of reply. Only the personas actually named in a round
two objection are called again, and each is shown only the objections aimed
at it. Usually that is one or two agents, not four.

This round is what makes the board a discussion rather than a round of
complaints filed with the CEO. Without it, the CMO objects to the CFO and
the CFO never answers, which is a response, not an exchange. With it the
transcript reads position → objection → answer, and the CEO can watch an
argument play out instead of reading four parallel statements about each
other.

Round three does not re-open round two. A reply cannot raise a new objection
against a third persona, because that would need a fourth round to answer and
the loop would not terminate. Replies defend or concede, nothing else.

**The chair.** A fifth agent, not a board member and not a voting persona,
turns the debate into the single answer the CEO actually reads. It has the
same grounding tools and the same prohibition on inventing numbers, but no
lens of its own to argue from.

The chair always answers. It never asks the CEO a question and never returns
the decision unmade. Where the board reached agreement, it states the
recommendation and the reasoning. Where the board is genuinely split, it
still commits to a recommendation, but says the split out loud inside the
answer: which personas disagree, what each is optimising for, and what fact
about the CEO's own priorities would flip the recommendation the other way.

A worked example of a split answer:

> Hold the spend. The board is split. CFO wants to cut, runway is down to
> nine months. CMO wants to hold, payback is still under twelve months and
> share is climbing. Hold is right if market position matters more to you
> than cash cushion right now. If cash is the binding constraint, the answer
> flips to cut.

This is a deliberate product choice. The CEO asked a question and should get
an answer, not a question back. Handing an unmade decision to the CEO on
every contested topic would make the tool feel like it is dodging. Naming the
flip condition instead gives the CEO both a real answer and the lever to
overrule it in one move.

## The CEO Interrupt

An agent that is missing a fact it needs may stop the board and ask the CEO
for it. Only round one can do this. By rounds two and three the agents are
arguing with each other, not gathering information, and allowing an
interrupt there means the board could stall the CEO two or three times on a
single question.

When any agent raises a question, the entire board stops. Agents still
mid-response are not shown; the session halts as one. If more than one agent
raises a question in round one, they are batched into a single interrupt
rather than surfaced one at a time. The thread status becomes
`waiting_on_ceo` and the pending question or questions are stored on the
thread.

Once the CEO answers, the answer is injected into the shared thread and the
board **continues from where it stopped**. Round one is not re-run. Agents
that had already answered keep their answers; the agent that asked now has
what it needed and proceeds.

The whole board stopping is the point, not a limitation. This is what a real
boardroom does when someone asks the chair a question, everyone waits. The
UI is what carries that, see below.

**A CEO's answer is scoped to the thread that asked for it.** It lives in
that thread's shared memory and nowhere else. A later thread that needs the
same figure asks again rather than reusing it. Promoting spoken answers into
durable company facts would mean holding two sources of truth, the uploaded
dataset and things the CEO once said, plus rules for what happens when a new
upload contradicts an older answer. That is real work with no payoff at
prototype scope, so it belongs in the write up as a production extension
rather than in this build.

## Grounding

P&L figures and KPIs are uploaded as CSV or JSON and written to a JSON file
beside the seed dataset, gitignored, which the grounding tools read. Mongo is
deliberately not in this path: it holds board threads only. Grounding that
depended on a database would break for a reviewer who clones the repo and
points at an unseeded cluster, and the storage adapter exposes no key-value
domain to put a single document in anyway. The seed dataset ships in the repo,
so the board answers grounded questions on a fresh checkout with no database
and no upload.

Agents do not receive this data as static text inside the system prompt. Each
agent fetches numbers on demand through a small set of narrow tools:

- `listPeriods()` — which quarters exist, so an agent never guesses a
  period name
- `getMetric(name, period)` — one scalar, e.g. gross margin for 2025-Q3
- `compareMetric(name, fromPeriod, toPeriod)` — the value at each end plus
  absolute and percentage delta
- `getSegmentMix(period)` — revenue and margin split by segment

A single scalar lookup is not enough. The questions these personas
actually ask are comparative and compositional: *did margin fall because
of mix shift or COGS inflation?* That needs a quarter over quarter delta
and a segment split, so those are first class tools rather than something
the model has to assemble from repeated scalar calls and arithmetic it
may get wrong.

Narrow tools with explicit period arguments force every claim in an
agent's response to trace back to an actual queried value rather than a
plausible sounding guess. That is the main defense against ungrounded
advice, which the assignment specifically calls out as a failure mode to
avoid.

Missing data is what triggers a CEO interrupt. An agent that needs a figure
the dataset does not contain asks the CEO for it rather than estimating.

## Persistence

MongoDB holds board threads, keyed by thread ID, via Mastra's
`@mastra/mongodb` storage adapter. Each thread stores the CEO's questions,
all three rounds, the chair's answer, any pending CEO facing question, and
which agents participated. Thread status is one of `running`,
`waiting_on_ceo`, or `resolved`, so a returning CEO can tell at a glance
whether the board is mid debate, stalled on a question for them, or done.
Mastra's built in thread and memory handling covers loading this back in
when the CEO returns to an existing board conversation instead of starting
fresh.

Storage is the one piece of this prototype that needs a running service.
Reviewers without a local MongoDB can swap the adapter for
`@mastra/libsql`, which writes to a file and needs no setup; the change is
one import and one connection string, and nothing else in the system
depends on which one is used.

## Tech Stack

- **Agent orchestration:** Mastra, one agent per persona, shared board
  thread, tool calling for grounded data lookups. The interrupt is a
  workflow `suspend()` / `resume()` pair, which is what makes stopping and
  continuing from the same point possible rather than re-running the round
- **Backend:** the Mastra server itself. It already serves HTTP and takes
  custom `apiRoutes`, which is where the board thread API and the CSV/JSON
  upload endpoint live. No Express. A second process would need its own
  port, its own Mongo client, and its own copy of the agent context, all
  to re-expose what Mastra already exposes
- **Database:** MongoDB via `@mastra/mongodb`, board threads and uploaded
  P&L/KPI data
- **Frontend:** Next.js with assistant-ui, `useChatRuntime` from
  `@assistant-ui/react-ai-sdk` bridged to Mastra's agent stream through
  `@mastra/ai-sdk`
- **LLM provider:** Anthropic

## UI

CFO built first end to end, persona, tool calling, streaming, saved to
Mongo, then CMO, COO, CSO reuse that same pipeline with new prompts and
tools rather than new plumbing.

**The answer leads.** The chair's single answer is the primary content of
every board response. Directly beneath it sits the debate, three labelled
sections, opening positions, where the board disagreed, and replies, each
objection and reply naming who it is aimed at.

**The debate is open by default on a thread's first answer,** then follows
whatever the CEO last chose. Someone seeing the tool for the first time
watches the argument without having to discover it; someone who has read
enough of them can collapse it and keep it collapsed. The state persists per
thread.

This matters beyond taste. The assignment requires the CEO to see the
exchange, so a debate hidden behind a click on first load risks a reviewer
never opening it and never seeing the feature the build is mostly about.

**The waiting state is a first class screen, not a spinner.** When the board
stops for a CEO question, the UI shows the board as stopped and waiting: all
four personas visibly paused, the asking persona highlighted with its
question, and an input clearly bound to answering that question rather than
starting a new one. A CEO returning to a `waiting_on_ceo` thread lands on
this same state. It should read as a room full of people looking at you, not
as an app that has hung.

**Rounds render whole.** A round's agents run concurrently, so streaming them
token by token would interleave four voices into noise; each round is
written to the stream once complete, in a fixed persona order.

**Addressing one persona.** The chat input carries a target selector, whole
board by default, or a single persona. A message aimed at one persona calls
only that agent and skips the three round debate and the chair entirely,
since there is nothing to debate and nothing to synthesise. Those replies
render as a plain single agent message inside the same thread.

**Grounding evidence attaches to the persona that fetched it.** Each
persona's tool calls sit with that persona's own opening inside the debate
section, collapsed, labelled as evidence rather than thinking, so the CEO can
confirm an executive actually queried the numbers it cited. The debate section
itself is never wrapped in a Chain of Thought container. The rule being
protected is that nothing collapses twice: one disclosure to open the debate,
one to open a persona's evidence, and no third layer between them. A message
addressed to a single persona carries the same evidence disclosure on the
reply itself, since there is no debate section to sit inside.

Implementation note: assistant-ui's built in Chain of Thought groups
reasoning and tool-call parts from a single agent's stream. The debate is
not that, it is separate agent outputs produced by a workflow, so it ships
as custom data parts rendered in a purpose built collapsible section styled
to match, not by pointing the built in feature at it.

## Out of Scope

- Auth, per the assignment's own instructions
- Real financial system integrations, mock CSV/JSON upload is sufficient
- More than four board personas, the chair aside
- A fourth debate round. Replies defend or concede; they do not open new
  fronts, because answering those would need a fifth round
- CEO interrupts from rounds two and three
- Polish beyond what's needed to demonstrate the debate and grounding

## Assumptions

- One board thread per CEO, not per company, for this prototype
- Uploaded P&L data is trusted as is, no validation layer on the upload
- Round two runs for every agent, but only agents that return
  `disagrees: true` appear in the transcript, so it does not feel padded
  when all four actually agree
- An agent is a fair judge of whether it disagrees. Cheaper and more
  inspectable than a separate judge model; if agents turn out to be
  agreeable to a fault, a judge is the fallback
- A single reply is enough to make the exchange feel real. If the CEO
  routinely wants the argument to go further, that is a signal to make round
  count a per-question setting rather than to raise the cap
- A chair with no lens stays neutral. Committing to a recommendation is not
  a lens; if it starts consistently favouring one persona's framing, the fix
  is to strip its opinion further, not to give it a vote
- Agents ask the CEO only for facts, not for direction. An agent asking the
  CEO to make the decision is a prompt failure, not a feature
- Cost scales with disagreement, not with board size: a unanimous board
  costs eight agent calls plus the chair, a contested one adds one call per
  persona that was objected to

## Open Questions

None outstanding.
