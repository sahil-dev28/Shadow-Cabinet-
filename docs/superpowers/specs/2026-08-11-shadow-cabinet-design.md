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
responses from four distinct executive personas, CFO, CMO, COO, and CSO,
who each reason from their own priorities, push back on each other in a
visible exchange, ground their advice in real uploaded numbers instead of
generic advice, and pick up an ongoing board conversation across sessions.

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

Debate happens in exactly three passes, closed by a chair. Three is a hard
limit, not a starting point, so a disagreement cannot loop without
resolution.

**Pass one.** The CEO's question goes to all four agents concurrently. Each
responds using its own persona and the grounding data it pulls itself. The
shared thread means each agent sees the full history of *earlier* turns,
but because pass one runs concurrently no agent sees its siblings' pass one
replies while writing its own. Four genuinely independent positions land
instead of three agents converging on whoever answered first.

All four are asked every time. No router decides which personas are
"relevant" — with a board this small, a routing step adds a failure mode
and a round trip to save one paragraph, and an agent with nothing to add
can say so in one line.

**Pass two.** Every pass one agent is shown the others' replies and returns
structured output rather than prose:

```ts
{ disagrees: boolean, with: PersonaId[], statement: string }
```

Only entries with `disagrees: true` are rendered to the CEO. The agent
itself decides whether it has a real objection, which needs no separate
judge model and no keyword heuristic, and the boolean makes the decision
inspectable in the stored thread. This is what produces CFO pushing back on
CMO's spend request instead of four agents answering past each other.

**Pass three.** Right of reply. Only the personas actually named in a pass
two objection are called again, and each is shown only the objections aimed
at it. Usually that is one or two agents, not four.

This pass is what makes the board a discussion rather than a round of
complaints filed with the CEO. Without it, the CMO objects to the CFO and
the CFO never answers, which is a response, not an exchange. With it the
transcript reads position → objection → answer, and the CEO watches an
argument play out instead of reading four parallel statements about each
other.

Pass three does not re-open pass two. A reply cannot raise a new objection
against a third persona, because that would need a fourth pass to answer and
the loop would not terminate. Replies defend or concede, nothing else.

**The chair.** A fifth agent, not a board member and not a voting persona,
closes every session with three things: what the board agreed on, what is
still contested and why, and the decision that is now the CEO's to make. It
has the same grounding tools and the same prohibition on inventing numbers,
but no lens of its own to argue from.

The chair exists because four executives and a round of rebuttals is a lot
of text to hand a CEO with no landing. Its job is to make the disagreement
actionable, not to resolve it. Where the board is genuinely split, the chair
says so and names the trade-off rather than picking a side.

The CEO sees all three passes and the chair's read before weighing in.

## Grounding

P&L figures and KPIs are uploaded as CSV or JSON and loaded into MongoDB
at session start. Agents do not receive this data as static text inside
the system prompt. Each agent fetches numbers on demand through a small
set of narrow tools:

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

## Persistence

MongoDB holds board threads, keyed by thread ID, via Mastra's
`@mastra/mongodb` storage adapter. Each thread stores the CEO's questions,
both debate passes, and which agents participated. Mastra's built in
thread and memory handling covers loading this back in when the CEO
returns to an existing board conversation instead of starting fresh.

Storage is the one piece of this prototype that needs a running service.
Reviewers without a local MongoDB can swap the adapter for
`@mastra/libsql`, which writes to a file and needs no setup; the change is
one import and one connection string, and nothing else in the system
depends on which one is used.

## Tech Stack

- **Agent orchestration:** Mastra, one agent per persona, shared board
  thread, tool calling for grounded data lookups
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

The debate view renders four visibly separate sections rather than one
merged answer: opening statements, where the board disagrees, replies, and
the chair's read. Each objection and each reply names who it is aimed at, so
the exchange is something the CEO can watch happening rather than something
asserted in text.

Rounds render whole. A round's agents run concurrently, so streaming them
token by token would interleave four voices into noise; each round is
written to the stream once it is complete, in a fixed persona order.

## Out of Scope

- Auth, per the assignment's own instructions
- Real financial system integrations, mock CSV/JSON upload is sufficient
- More than four board personas, the chair aside
- A fourth debate pass. Replies defend or concede; they do not open new
  fronts, because answering those would need a fifth pass
- Polish beyond what's needed to demonstrate the debate and grounding

## Assumptions

- One board thread per CEO, not per company, for this prototype
- Uploaded P&L data is trusted as is, no validation layer on the upload
- Pass two runs for every agent, but only agents that return
  `disagrees: true` are shown to the CEO, so responses do not feel padded
  when all four actually agree
- An agent is a fair judge of whether it disagrees. Cheaper and more
  inspectable than a separate judge model; if agents turn out to be
  agreeable to a fault, a judge is the fallback
- A single reply is enough to make the exchange feel real. If the CEO
  routinely wants to see the argument go further, that is a signal to make
  round count a per-question setting rather than to raise the cap
- A chair with no lens stays neutral. If it starts favouring a persona, the
  fix is to strip its opinion further, not to give it a vote
- Cost scales with disagreement, not with board size: a unanimous board
  costs eight agent calls plus the chair, a contested one adds one call per
  persona that was objected to

## Open Questions

- Whether the CEO should be able to directly address one persona mid
  debate, or only ever address the whole board
