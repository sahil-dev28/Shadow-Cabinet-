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
who each reason from their own priorities, debate with each other
automatically, ground their advice in real uploaded numbers instead of
generic advice, and pick up an ongoing board conversation across sessions.

## Personas

- **CFO** — financial discipline, P&L, margins, cash flow, risk
- **CMO** — brand, demand generation, customer acquisition, market share
- **COO** — operations, execution, efficiency
- **CSO** — competitive strategy, market positioning, long term bets

No CTO or CRO added for this prototype. Scope stays at four to keep the
debate readable and to leave time for the orchestration and grounding work,
which matter more to this evaluation than persona count.

## Proposed Approach

Each persona is a distinct Mastra agent with its own system prompt and its
own memory scope, so persona voice cannot bleed across agents. All four
agents share one board level thread ID, so every agent sees the same CEO
question and the same debate history rather than reasoning in isolation.

Debate runs as a bounded, automatic round loop rather than a single fan
out, and rather than an open ended free for all.

**Round 1.** The CEO's question goes to every relevant agent independently.
Each agent responds directly to the CEO in its own voice, with a concrete
recommendation, using only the grounding data it pulls itself. Any agent
whose reasoning depends on information it doesn't have may raise a
question, either to another agent or to the CEO.

**CEO questions pause the board.** If any agent raises a question for the
CEO, the thread status flips to waiting and the round halts. If more than
one agent raises a CEO question in the same round, they're batched into a
single pause rather than asked one at a time. The board resumes once the
CEO answers, with that answer injected back into context for the agent
that asked.

**Round 2.** Triggered only when there's genuine disagreement or an
unanswered agent to agent question left over from round 1, not on every
question. Objecting agents challenge, the objected to agent replies, and
any pending agent to agent question gets answered. This is what produces
CFO pushing back on CMO's spend request and CMO actually responding to
that pushback, instead of two agents talking past each other.

**Cap at two rounds.** If the board still disagrees after round 2, each
agent gives its final recommendation, flags that it disagrees with the
others, and hands the decision to the CEO rather than looping trying to
force consensus that four agents with genuinely different priorities
probably shouldn't reach anyway.

The CEO sees the full exchange, every round, every question and answer,
before weighing in themselves.

## Grounding

P&L figures and KPIs are uploaded as CSV or JSON and loaded into MongoDB
at session start. Agents do not receive this data as static text inside
the system prompt. Each agent calls a tool, `getMetric(name, period)`,
to fetch numbers on demand. This forces every claim in an agent's
response to trace back to an actual queried value rather than a plausible
sounding guess, and it is the main defense against ungrounded advice,
which the assignment specifically calls out as a failure mode to avoid.

## Persistence

One MongoDB collection holds board threads, keyed by thread ID. Each
document stores the CEO's questions, every round of the debate, any
pending CEO facing questions, and which agents participated. Thread state
is one of running, waiting on CEO, or resolved, so a returning CEO can see
whether the board is mid debate, stalled on a question for them, or done.
Mastra's built in thread and memory handling covers loading this back in
when the CEO returns to an existing board conversation instead of
starting fresh.

## Tech Stack

- **Agent orchestration:** Mastra, one agent per persona, shared board
  thread, tool calling for grounded data lookups
- **Backend:** Express, exposes the board thread API and the metric
  lookup tool's data source
- **Database:** MongoDB, board threads and uploaded P&L/KPI data
- **Frontend:** Next.js with assistant-ui, `useChatRuntime` from
  `@assistant-ui/react-ai-sdk` bridged to Mastra's agent stream through
  `@mastra/ai-sdk`
- **LLM provider:** Anthropic

## UI

CFO built first end to end, persona, tool calling, streaming, saved to
Mongo, then CMO, COO, CSO reuse that same pipeline with new prompts and
tools rather than new plumbing. The debate view renders each round as a
visibly separate exchange, not a single merged answer, so the disagreement
the assignment asks for is something the CEO can actually see happening.
When the board is waiting on the CEO, the UI needs a clear state showing
which agent asked what, rather than looking like the app has stalled.

## Out of Scope

- Auth, per the assignment's own instructions
- Real financial system integrations, mock CSV/JSON upload is sufficient
- More than four personas
- Polish beyond what's needed to demonstrate the debate and grounding
- A chair or moderator persona that synthesizes the board's view into one
  recommendation, the CEO is meant to weigh the raw debate and decide
  themselves, per the assignment's framing

## Assumptions

- One board thread per CEO, not per company, for this prototype
- Uploaded P&L data is trusted as is, no validation layer on the upload
- Round 2 only fires on genuine disagreement or an unanswered agent to
  agent question, not on every question, to keep responses from feeling
  padded when all four agents actually agree
- Multiple CEO facing questions in the same round are batched into a
  single pause rather than surfaced one at a time

## Open Questions

- Whether the CEO should be able to directly address one persona mid
  debate, or only ever address the whole board
