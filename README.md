# Shadow Cabinet

A virtual CXO board. The CEO puts one business question to four executive
personas — CFO, CMO, COO, CSO — and gets four independent positions, then
watches them push back on each other. Every figure in every answer is fetched
from the company's own data through tools, never recalled or estimated, and the
whole exchange lives in a thread that survives a restart.

## Setup

Prerequisites: Node >= 22.13.0, pnpm, an `ANTHROPIC_API_KEY`. MongoDB is
optional — **omit `MONGODB_URI` and the prototype falls back to a local libsql
file (`shadow-cabinet.db`), so it runs with no database installed.**

```bash
cp .env.example .env      # then paste your ANTHROPIC_API_KEY
pnpm install

pnpm dev                  # Mastra server on http://localhost:4111
cd shadow-cabinet-web && pnpm dev   # web app on http://localhost:3000
```

Open http://localhost:3000. It redirects to `/board/board-<uuid>` — that URL is
the board thread, and returning to it resumes the conversation.

## Try it

Ask:

> Our Q3 gross margin dropped 4 points to 58%. What should we do?

Look for two things. First, four opening statements that disagree about what
matters: the CFO on margin structure, the CMO on what a spend cut does to
pipeline, the COO on whether the plan can be staffed, the CSO on whether the
mix shift was the point. Second, a disagreement section naming who is objecting
to whom — the seed data is built so the CFO and CSO land on opposite sides of
the same Freight Brokerage numbers.

A board session takes two to four minutes. It is eight agent calls with tool
use, not one chat completion.

## Design write-up

**How the personas are modelled.** One factory, `createPersonaAgent()`, builds
all four agents. It owns the entire response contract — grounding rules, answer
shape, length — and each persona supplies only a `lens` (what it optimises for)
and a `character` (how it argues, and who it clashes with). A shared contract is
what keeps four voices distinct without producing four answer formats: the
difference between executives shows up as different conclusions from the same
figures, not as one agent writing memos while another writes bullet points.

**How the debate is orchestrated.** Two passes, a hard limit rather than a
starting point, so a disagreement cannot loop. Pass one fans the question out to
all four personas concurrently and blind — no agent sees a sibling's answer
while writing its own, so four genuinely independent positions land instead of
three agents converging on whoever replied first. Pass two shows each persona
the others' openings and asks for `{ disagrees, with, statement }` as structured
output. The agent judges its own objection, which needs no separate judge model
and no keyword heuristic, and the boolean stays inspectable in the stored
thread. Only `disagrees: true` entries with a non-empty statement are rendered,
so a board that genuinely agrees does not produce a padded disagreement section.

**Shared context versus isolated reasoning.** All four agents share one board
thread, which in Mastra means one memory scope: every agent sees the same CEO
question and the same history. Persona distinctness comes from instructions, not
from memory isolation. The two are independent, and conflating them is what
makes multi-agent systems either amnesiac or indistinguishable.

**Grounding.** Numbers never enter a system prompt. Four narrow tools —
`listPeriods`, `getMetric`, `compareMetric`, `getSegmentMix` — read a
`CompanyData` value through pure query functions. `compareMetric` and
`getSegmentMix` exist because the questions these personas actually ask are
comparative and compositional ("did margin fall from mix shift or COGS
inflation?"); assembling that from repeated scalar lookups means the model does
arithmetic, which is exactly where invented numbers come from. Tool errors are
returned as data (`{ ok: false, error }`) with the valid periods or metrics
listed, so a model that guesses a period name gets a correction it can act on
instead of a failed run.

**What was left out and why.** No router deciding which personas are relevant —
with a board this small it adds a failure mode and a round trip to save one
paragraph, and an agent with nothing to add can say so in a line. No CTO or CRO;
four keeps the debate readable. No auth, per the assignment. No per-token
streaming attribution: a round's agents run concurrently, so streaming them
token by token would interleave four voices into noise, and each round is
written out whole in a fixed persona order instead.

**What production would need next.** Evals on persona distinctness and on
grounding (does every quoted figure trace to a tool call?). Per-round cost and
latency budgets — a contested board is eight agent calls with tool use. Access
control on `resourceId`; Mastra does not enforce it. A real CSV parser. Retry
and fallback when one persona fails mid-round, which currently fails the round.

**Assumptions.** One CEO, one board thread per session, uploaded data trusted
as-is with no validation layer.

## Company data

The board reads `shadow-cabinet-server/src/mastra/data/company-data.json` by
default: four quarters of P&L, KPIs and segment mix for a fictional logistics
company. Upload your own to replace it:

```bash
curl -X POST http://localhost:4111/company-data \
  -H "Content-Type: application/json" \
  -d '{"format":"csv","company":"Yourco","csv":"period,revenue,cogs,..."}'
```

`format` is `"csv"` or `"json"`. Uploads persist to
`company-data.uploaded.json` beside the seed and take precedence over it;
delete that file to go back to the seed.

## Tests

```bash
pnpm test              # vitest
pnpm exec tsc --noEmit # types
```

Tested: the pure query functions, the four tool wrappers, transcript rendering
and disagreement filtering, the CSV parser, and that every persona is wired with
the grounding tools and forbidden from inventing numbers. Not tested: model
prose. Asserting on what a language model says is a trap; the debate itself is
verified by running it.
