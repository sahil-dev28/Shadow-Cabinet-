# Chair, Three Rounds, and the CEO Interrupt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board answers a CEO question with one chair-written recommendation, produced by three rounds of debate the CEO can open underneath it, pausing to ask the CEO for missing facts and continuing from where it stopped.

**Architecture:** The existing two-round Mastra workflow gains a third round (right of reply) and a fifth non-voting chair agent that turns the debate into the single answer. Round-one agents now raise their own CEO questions as structured output instead of a classifier inferring them; the workflow suspends, stores a `waiting_on_ceo` status, and resumes without re-running round one. The Next proxy stops rendering the debate as prose: it emits the chair's answer as the message text and the whole debate as one `data-board-debate` part, which a purpose-built collapsible component renders.

**Tech Stack:** Mastra 1.57 (`@mastra/core`, `@mastra/memory`, `@mastra/mongodb`), Anthropic `claude-sonnet-4-5` and `claude-haiku-4-5`, Zod 4, Next.js 16 + assistant-ui + `ai@7`, Vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-11-shadow-cabinet-design.md`

**Supersedes:** `docs/superpowers/plans/2026-08-11-cxo-board.md`. That plan built the two-round board with no chair. Do not consult it for task order or file contents — where the two disagree, this plan wins.

## Global Constraints

- Node `>=22.13.0`. ESM only. Local imports carry the `.ts` extension (`./agents/chair.ts`); `allowImportingTsExtensions` is set in the root `tsconfig.json`.
- Persona and chair model string is always `anthropic/claude-sonnet-4-5`. Cheap classification uses `anthropic/claude-haiku-4-5` via the per-call `model` override on `agent.generate()`. Never `anthropic:` and never a provider object.
- Zod 4 (`zod@^4.4.3`) for every schema. Tools MUST use `createTool()` from `@mastra/core/tools`.
- Custom API route paths must NOT start with `/api` — that prefix is reserved for built-in Mastra routes.
- Debate is exactly three rounds. A CEO interrupt is possible in round one only.
- The chair never asks the CEO a question and never returns the decision unmade.
- A CEO's answer is scoped to the thread that asked. Never write it anywhere a later thread can read.
- Run the server from the repo root with `pnpm dev`; the web app from `shadow-cabinet-web` with `pnpm dev`.
- Type-check with `pnpm exec tsc --noEmit` from the repo root (server) and from `shadow-cabinet-web` (web). Tests with `pnpm test` from the repo root — Vitest picks up both packages.
- The Mastra dev server rebuilds on file save. After editing anything under `shadow-cabinet-server/src/mastra/`, wait for `curl -s -o /dev/null -w "%{http_code}" http://localhost:4111/api/agents` to return `200` before running a live check, or the request will fail against a half-reloaded server. **Then touch no file under that directory until the run reaches a terminal state.** A rebuild mid-run kills the run: Mastra's restart path cannot rehydrate an in-flight `foreach` and throws `Cannot read properties of undefined (reading 'length')`. A live board costs minutes and real model calls, so a stray comment fix means paying for it twice.

## Current State

These exist and are working. Do not rebuild them.

| Path | What it already does |
|---|---|
| `agents/persona.ts` | `createPersonaAgent(config)`, `PERSONA_IDS`, `PersonaId`, `PersonaConfig`. Guardrail processors, `Memory({ options: { lastMessages: 20 } })`, `companyDataTools` |
| `agents/index.ts` | `PERSONAS`, `boardAgents`, per-persona exports |
| `tools/company-data-tools.ts` | `listPeriodsTool`, `getMetricTool`, `compareMetricTool`, `getSegmentMixTool`, `companyDataTools` |
| `workflows/transcript.ts` | `OpeningEntry`, `RebuttalEntry`, `sortByBoardOrder`, `renderOpeningRound`, `filterDisagreements`, `renderRebuttalRound`, `formatOpeningsForRebuttal` |
| `workflows/board-session.ts` | `boardSession` workflow: `openingStep` (concurrency 4) → `renderOpeningsStep` → `triageStep` → `ceoPauseStep` → `rebuttalStep` (concurrency 4) → `renderRebuttalsStep`. Also `evidenceSchema`, `personaTurnSchema`, `collectEvidence`, `tripwireNotice` |
| `data/board-sessions.ts` | `saveBoardSession`, `listBoardSessions` (Mongo when `MONGODB_URI` is set, JSON file otherwise) |
| `data/pending-runs.ts` | `savePendingRun`, `getPendingRun`, `clearPendingRun` |
| `routes/board-history.ts` | `GET /board/:threadId/messages` → `{ sessions, pending }` |
| `routes/board-reception.ts` | `POST /board/reception` → `{ convene, reply }`, the greeting gate |
| `lib/board.ts` (web) | `runBoardSession()` — detached start, polling, `onRoundOne`, `resumeRunId`, `BoardOutcome` |
| `app/api/chat/route.ts` (web) | Reception gate, `pendingRunId`, `writeOpenings`, `waitingMarkdown`, SSE stream |
| `components/assistant-ui/thread.tsx` | `GroupedParts` chain-of-thought card labelled "Checked N figures", `case "data": return part.dataRendererUI` |

### Already landed — do not redo

Work done after this plan was written. Reading it as "not yet built" and
following the code blocks literally would delete tested behaviour.

| What | Commit | Consequence for this plan |
|---|---|---|
| Resume no longer re-runs round one; the CEO's answer is written into the shared thread | `b3f7b21` | **Task 2 Step 3 is complete.** Skip it. Verify by reading `ceoPauseStep` — if its resume branch calls `agent.generate`, the change was reverted; otherwise leave it alone |
| A persona that throws renders as unavailable instead of failing the round | `b3f7b21` | `openingStep` and `rebuttalStep` each wrap their agent call in try/catch and return `personaUnavailable(...)`. Every code block below that rewrites those steps **must keep the guard** |
| `openingStep`, `rebuttalStep`, `ceoPauseStep` are exported | `b3f7b21` | `board-session.test.ts` imports them. The code blocks below show `const …` for brevity — keep the `export` |
| `board-session.test.ts`, six tests | `b3f7b21` | Any task changing a step's input or output shape must update this file in the same task. A task that leaves it red is not done |
| Uploads validated with `companyDataSchema` at `POST /company-data` | `8f9e745` | Unrelated to these tasks; do not remove |
| Round three shipped with narrower carried schemas than this plan drafted | `a49968c` | **Task 4 must use `objectionSchema` and `replyTurnSchema`**, not `rebuttalEntrySchema` and `replyEntrySchema`. `rebuttalEntrySchema` carries round one on every entry; embedding it per reply copied round one sixteen times through the fan-out. `renderDebateStep.outputSchema.replies` is `{ personaId, text }` |
| `renderDebateStep` returns `transcript` and calls `saveBoardSession` | `a49968c` | Kept deliberately: `lib/board.ts` throws without `transcript`, so dropping it breaks the running web app until Task 6. `chairStep` can read `inputData.transcript` instead of rebuilding it. Task 5 still moves `saveBoardSession` into `chairStep` |
| Sessions store `answer`, narrow `objections` and `replies`; `rebuttalsMarkdown` is gone from `BoardSession` | `897ebb7` | **`shadow-cabinet-web/lib/history.ts` is broken right now.** It reads `session.rebuttalsMarkdown.trim()` from the history route, which no longer sends that field. The `TypeError` is swallowed by `fetchBoardHistory`'s `try`, so a reopened thread silently renders empty rather than crashing, and web `tsc` stays clean because the web declares its own `BoardHistorySession`. **Task 6 fixes this, not Task 10** — leaving it until Task 10 means shipping four tasks with rehydration quietly dead |
| Sessions written before `897ebb7` are half-empty | `897ebb7` | Rows from the old save site have `personas` and `question` only, no `answer`. Rehydration must tolerate a missing `answer` by skipping that session rather than throwing |
| `running` is the catch-all status | `897ebb7` | A thread with no session and no pending run reports `running`, so an unknown thread id reads as a board in progress. Task 8's waiting screen must key off `waiting_on_ceo` specifically, never off "not resolved" |
| Unopposed boards emit one persona-less reply item (`personaId: null`) via the exported `toReplyInputs` | `a49968c` | This is what keeps `inputData[0]` populated for `renderDebateStep`. `renderDebateStep` filters the null out of `replies`. Do not "simplify" it away |

Two behaviours contradict the spec and are removed by this plan: `triageStep` infers CEO questions from the openings rather than the agents raising them (Task 2), and `ceoPauseStep` re-generates the asking personas' openings on resume rather than keeping their answers (Task 2).

## File Structure

**Server** (`shadow-cabinet-server/src/mastra/`):

| Path | Responsibility |
|---|---|
| `workflows/transcript.ts` | Add reply-round rendering and objection routing. Stays pure — no Mastra, no LLM |
| `workflows/transcript.test.ts` | Tests for the above |
| `agents/chair.ts` | The chair agent: no lens, grounding tools, always answers |
| `agents/chair.test.ts` | Chair is wired with tools and forbidden from asking questions |
| `workflows/board-session.ts` | Agent-raised questions, round three, chair step, new workflow output |
| `data/board-sessions.ts` | Store the answer, all three rounds, and thread status |
| `routes/board-history.ts` | Return status, answer, and rounds |

**Web** (`shadow-cabinet-web/`):

| Path | Responsibility |
|---|---|
| `lib/board.ts` | Outcome carries `answer` + `rounds`; single-persona path |
| `lib/board.test.ts` | Tests for the above |
| `lib/debate.ts` | `BoardDebate` type shared by the proxy, the renderer, and rehydration |
| `app/api/chat/route.ts` | Emit answer as text, debate as one data part, waiting as one data part |
| `components/assistant-ui/board-debate.tsx` | Collapsible three-section debate |
| `components/assistant-ui/board-waiting.tsx` | Waiting-on-CEO screen |
| `components/assistant-ui/thread.tsx` | Register both data renderers |
| `app/assistant.tsx` | Persona target selector |
| `lib/history.ts` | Rehydrate answer + debate parts |
| `README.md` | Design write-up matches the shipped board |

---

### Task 1: Reply-round rendering and objection routing

Pure functions, no Mastra and no model calls, so round three can be built and tested before any agent is wired to it.

**Files:**
- Modify: `shadow-cabinet-server/src/mastra/workflows/transcript.ts`
- Modify: `shadow-cabinet-server/src/mastra/workflows/transcript.test.ts`

**Interfaces:**
- Consumes: `PERSONAS`, `PERSONA_IDS`, `PersonaId` from `../agents/index.ts`; existing `RebuttalEntry`, `sortByBoardOrder`, `filterDisagreements`.
- Produces:
  - `type ReplyEntry = { personaId: PersonaId; text: string }`
  - `personasNamedIn(entries: RebuttalEntry[]): PersonaId[]` — board-ordered, de-duplicated, only from entries that survive `filterDisagreements`
  - `objectionsAimedAt(entries: RebuttalEntry[], target: PersonaId): RebuttalEntry[]`
  - `formatObjectionsForReply(entries: RebuttalEntry[], target: PersonaId): string`
  - `renderReplyRound(entries: ReplyEntry[]): string`

- [ ] **Step 1: Write the failing tests**

Append to `shadow-cabinet-server/src/mastra/workflows/transcript.test.ts`:

```ts
import {
  type ReplyEntry,
  formatObjectionsForReply,
  objectionsAimedAt,
  personasNamedIn,
  renderReplyRound,
} from "./transcript.ts";

const objections: RebuttalEntry[] = [
  { personaId: "cmo", disagrees: true, with: ["cfo"], statement: "Cutting spend forfeits pipeline." },
  { personaId: "coo", disagrees: true, with: ["cfo", "cso"], statement: "Neither plan can be staffed." },
  { personaId: "cso", disagrees: false, with: [], statement: "" },
];

describe("personasNamedIn", () => {
  it("lists every persona objected to, in board order, once each", () => {
    expect(personasNamedIn(objections)).toEqual(["cfo", "cso"]);
  });

  it("ignores entries that did not really disagree", () => {
    expect(
      personasNamedIn([
        { personaId: "cmo", disagrees: true, with: ["cfo"], statement: "   " },
        { personaId: "coo", disagrees: false, with: ["cso"], statement: "" },
      ]),
    ).toEqual([]);
  });
});

describe("objectionsAimedAt", () => {
  it("returns only the objections naming that persona", () => {
    const aimed = objectionsAimedAt(objections, "cso");
    expect(aimed.map((entry) => entry.personaId)).toEqual(["coo"]);
  });
});

describe("formatObjectionsForReply", () => {
  it("shows the persona only what was aimed at it", () => {
    const prompt = formatObjectionsForReply(objections, "cfo");

    expect(prompt).toContain("CMO");
    expect(prompt).toContain("Cutting spend forfeits pipeline.");
    expect(prompt).not.toContain("Neither plan can be staffed."); // aimed at cfo AND cso
  });
});

describe("renderReplyRound", () => {
  it("renders one titled reply per persona in board order", () => {
    const markdown = renderReplyRound([
      { personaId: "cso", text: "Conceded on staffing." },
      { personaId: "cfo", text: "Payback still does not clear twelve months." },
    ]);

    expect(markdown).toContain("## Replies");
    expect(markdown).toContain("**CFO replies**");
    expect(markdown.indexOf("**CFO")).toBeLessThan(markdown.indexOf("**CSO"));
  });

  it("says so plainly when nobody had to reply", () => {
    expect(renderReplyRound([])).toContain("No replies were needed");
  });
});
```

Note: the third `formatObjectionsForReply` assertion is deliberate — the COO objection names both `cfo` and `cso`, so it must appear for both. Fix the test expectation to `toContain` if you change the fixture.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm test transcript`
Expected: FAIL — `personasNamedIn is not a function` (or an import error naming it).

- [ ] **Step 3: Implement the functions**

Append to `shadow-cabinet-server/src/mastra/workflows/transcript.ts`:

```ts
export interface ReplyEntry {
  personaId: PersonaId;
  text: string;
}

/** Only these personas are called in round three. Usually one or two, not four. */
export function personasNamedIn(entries: RebuttalEntry[]): PersonaId[] {
  const named = new Set<PersonaId>();
  for (const entry of filterDisagreements(entries)) {
    for (const target of entry.with) named.add(target);
  }

  return PERSONA_IDS.filter((id) => named.has(id));
}

export function objectionsAimedAt(
  entries: RebuttalEntry[],
  target: PersonaId,
): RebuttalEntry[] {
  return filterDisagreements(entries).filter((entry) =>
    entry.with.includes(target),
  );
}

/**
 * A persona replying sees only what was said about it. Showing the whole
 * round invites it to answer objections aimed at someone else, which is the
 * fourth round this design does not have.
 */
export function formatObjectionsForReply(
  entries: RebuttalEntry[],
  target: PersonaId,
): string {
  return objectionsAimedAt(entries, target)
    .map(
      (entry) =>
        `${entry.personaId.toUpperCase()} (${PERSONAS[entry.personaId].title}) objected:\n${entry.statement.trim()}`,
    )
    .join("\n\n");
}

export function renderReplyRound(entries: ReplyEntry[]): string {
  if (entries.length === 0) {
    return "## Replies\n\nNo replies were needed: nobody was objected to.\n";
  }

  const sections = sortByBoardOrder(entries).map(
    (entry) =>
      `**${entry.personaId.toUpperCase()} replies**\n\n${entry.text.trim()}`,
  );

  return `## Replies\n\n${sections.join("\n\n")}\n`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm test transcript`
Expected: PASS — the four new describes plus the five that were already there.

- [ ] **Step 5: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-server/src/mastra/workflows/transcript.ts shadow-cabinet-server/src/mastra/workflows/transcript.test.ts
git commit -m "feat: add reply-round rendering and objection routing"
```

---

### Task 2: Round-one agents raise their own CEO questions

The spec says an agent that is missing a fact asks for it. Today a `triageStep` reads the finished openings with a cheap model and guesses which questions were meant for the CEO — it invents questions the agent never asked, and it cannot know whether the agent was actually blocked. This replaces that with structured output from the agent itself, and fixes resume so round one is not re-run.

**Files:**
- Modify: `shadow-cabinet-server/src/mastra/workflows/board-session.ts`

**Interfaces:**
- Consumes: `collectEvidence`, `tripwireNotice`, `personaTurnSchema`, `evidenceSchema` (all already in this file); `renderOpeningRound` from `./transcript.ts`.
- Produces:
  - `openingEntrySchema` gains `questionForCeo: z.string()` — empty string when the agent is not blocked
  - `ceoQuestionSchema` = `{ personaId: PersonaId; question: string }` (already defined; keep it)
  - `roundOneStateSchema` drops `contested` and keeps `{ question, threadId, openings, openingsMarkdown, personas, ceoQuestions }`
  - `triageStep` is deleted

- [ ] **Step 1: Give the opening step a structured shape**

**Keep two things the block below omits for brevity:** the `export` keyword, and
the `try/catch` that returns `personaUnavailable(personaId, error)`. Both are
tested in `board-session.test.ts`. The structured call goes inside the existing
`try`; the `catch` is unchanged.

Replace the `openingStep` definition. The prose answer and the optional question come back in one call, so a blocked agent costs nothing extra:

```ts
const openingOutputSchema = z.object({
  position: z
    .string()
    .describe("Your answer to the CEO, in your own voice, under 200 words."),
  questionForCeo: z
    .string()
    .describe(
      "Ask ONLY if you cannot stand behind your position until the CEO personally answers, and only the CEO can answer it — never for a figure a tool could return. Ask for facts, never for the decision. Empty string otherwise, which is the normal case.",
    ),
});

const openingStep = createStep({
  id: "opening",
  inputSchema: z.object({
    personaId: personaIdSchema,
    question: z.string(),
    threadId: z.string(),
  }),
  outputSchema: openingEntrySchema,
  execute: async ({ inputData, mastra }) => {
    const { personaId, question, threadId } = inputData;
    const agent = mastra.getAgentById(`${personaId}-agent`);

    const response = await agent.generate(question, {
      memory: { resource: "ceo", thread: threadId },
      structuredOutput: { schema: openingOutputSchema },
    });

    const blocked = tripwireNotice(personaId, response);
    const opening = response.object ?? { position: response.text, questionForCeo: "" };

    return {
      personaId,
      text: blocked ?? opening.position,
      evidence: blocked ? [] : collectEvidence(response),
      questionForCeo: blocked ? "" : opening.questionForCeo.trim(),
      question,
      threadId,
    };
  },
});
```

Add the field to `openingEntrySchema`:

```ts
const openingEntrySchema = z.object({
  personaId: personaIdSchema,
  text: z.string(),
  evidence: z.array(evidenceSchema),
  questionForCeo: z.string(),
  question: z.string(),
  threadId: z.string(),
});
```

- [ ] **Step 2: Collect the questions where the round is assembled**

In `renderOpeningsStep`, add `ceoQuestions` to the output schema and build it from the entries. Delete `triageStep`, `triageSchema`, and `CEO_PAUSE_THRESHOLD` entirely:

```ts
  outputSchema: z.object({
    question: z.string(),
    threadId: z.string(),
    openings: z.array(z.object({ personaId: personaIdSchema, text: z.string() })),
    openingsMarkdown: z.string(),
    personas: z.array(personaTurnSchema),
    ceoQuestions: z.array(ceoQuestionSchema),
  }),
```

and inside its `execute`, alongside the existing `personas` mapping:

```ts
    const ceoQuestions = inputData
      .filter((entry) => entry.questionForCeo.length > 0)
      .map((entry) => ({
        personaId: entry.personaId,
        question: entry.questionForCeo,
      }));
```

Return it with the rest. Every agent that asked is included — batching is what the pause does with them, not a filter applied here.

- [x] **Step 3: Keep answers on resume — ALREADY DONE in `b3f7b21`**

Skip this step. `ceoPauseStep` already clears the pending run, writes the CEO's
answer into the shared thread via `memory.saveMessages`, and returns
`{ ...inputData, ceoQuestions: [] }` without re-generating any opening. It is
covered by "keeps the existing openings on resume instead of re-running round
one" in `board-session.test.ts`. The original text is kept below for context
only — do not apply it.

<details>
<summary>Original step, superseded</summary>

The spec is explicit that round one is not re-run and agents keep their answers. Replace the resume branch of `ceoPauseStep` — the version that loops over `inputData.personas` calling `agent.generate` — with a version that only records the answer:

```ts
    await clearPendingRun(inputData.threadId);

    // The answer is written to the shared thread, so every agent reads it on
    // its next turn. Round one is not re-run: the agents that already answered
    // keep their answers, and the one that asked now has what it needed.
    const agent = mastra.getAgentById("cfo-agent");
    const memory = await agent.getMemory();

    await memory?.saveMessages({
      messages: [
        {
          id: `ceo-answer-${runId}`,
          threadId: inputData.threadId,
          resourceId: "ceo",
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: `The CEO answered: ${resumeData.answer}` }],
          },
          createdAt: new Date(),
        },
      ],
    });

    return { ...inputData, ceoQuestions: [] };
```

Verify the `saveMessages` signature against the installed version before writing it:

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
grep -rn "saveMessages" node_modules/@mastra/core/dist/memory/*.d.ts | head -5
```

If the shape differs, match what the type says rather than this snippet — the requirement is that the answer lands in the thread the personas share, by any API the installed version offers.

</details>

- [ ] **Step 4: Point the graph at the new state**

`triageStep` is gone, so the chain becomes `.then(renderOpeningsStep).then(ceoPauseStep)`. `ceoPauseStep`'s input and output schemas both become `roundOneStateSchema` with `contested` removed. The `rebuttalStep` input schema drops `contested`, and its early-return branch for an uncontested board is deleted — round two runs for every agent, per the spec's Assumptions. Keep its `try/catch` and its `export`.

`board-session.test.ts` passes `contested: true` in both round-two cases; drop
that field there in the same commit, or the suite fails on an unknown key.

- [ ] **Step 5: Type-check**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Verify an agent can raise a question**

Start the server, wait for `200` from `/api/agents`, then:

```bash
RUN=$(curl -s -X POST http://localhost:4111/api/workflows/boardSession/create-run \
  -H "Content-Type: application/json" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['runId'])")
curl -s -X POST "http://localhost:4111/api/workflows/boardSession/start?runId=$RUN" \
  -H "Content-Type: application/json" \
  -d '{"inputData":{"question":"A competitor has offered to acquire our Freight Brokerage unit. Should we sell it?","threadId":"t2-questions"}}' -o /dev/null
sleep 90
curl -s "http://localhost:4111/api/workflows/boardSession/runs/$RUN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('status:', d.get('status'))
print('questions:', json.dumps((d.get('steps') or {}).get('render-openings',{}).get('output',{}).get('ceoQuestions'))[:400])
"
```

Expected: `status: suspended`, and at least one question whose text asks for a fact the dataset cannot hold (the offer price). A run that asks for gross margin instead is a prompt failure — tighten `questionForCeo`'s description before continuing.

- [ ] **Step 7: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-server/src/mastra/workflows/board-session.ts
git commit -m "feat: let round-one agents raise their own CEO questions"
```

---

### Task 3: Round three, the right of reply

**Files:**
- Modify: `shadow-cabinet-server/src/mastra/workflows/board-session.ts`

**Interfaces:**
- Consumes: `personasNamedIn`, `formatObjectionsForReply`, `renderReplyRound`, `ReplyEntry` from Task 1; `rebuttalEntrySchema` (already in the file).
- Produces:
  - `replyEntrySchema` = `{ personaId, text }`
  - `replyStep` — one persona, shown only the objections aimed at it
  - `renderRebuttalsStep` renamed to `renderDebateStep`, returning `{ question, threadId, personas, objections, replies, openingsMarkdown, rebuttalsMarkdown, repliesMarkdown }`

- [ ] **Step 1: Add the reply step**

`replyEntrySchema` carries round one and round two forward, the same way
`rebuttalEntrySchema` already carries `openingsMarkdown` — `foreach` hands the
next step only what its items return, so anything `renderDebateStep` needs must
ride along here:

```ts
const replyEntrySchema = z.object({
  personaId: personaIdSchema,
  text: z.string(),
  question: z.string(),
  threadId: z.string(),
  personas: z.array(personaTurnSchema),
  objections: z.array(rebuttalEntrySchema),
  openingsMarkdown: z.string(),
  rebuttalsMarkdown: z.string(),
});

/** Round three: defend or concede, nothing else. */
const replyStep = createStep({
  id: "reply",
  inputSchema: z.object({
    personaId: personaIdSchema,
    question: z.string(),
    threadId: z.string(),
    objections: z.array(rebuttalEntrySchema),
  }),
  outputSchema: replyEntrySchema,
  execute: async ({ inputData, mastra }) => {
    const { personaId, question, threadId, objections } = inputData;
    const agent = mastra.getAgentById(`${personaId}-agent`);

    const response = await agent.generate(
      `The CEO asked: "${question}"

Your fellow executives objected to your position:

${formatObjectionsForReply(objections, personaId)}

Answer them. Defend your position with figures you have fetched, or concede
the point plainly. Do not raise a new objection against anyone else and do not
ask the CEO anything — this is the last word before the chair writes the
answer. Under 120 words.`,
      { memory: { resource: "ceo", thread: threadId } },
    );

    const blocked = tripwireNotice(personaId, response);

    return {
      personaId,
      text: blocked ?? response.text,
      question,
      threadId,
      personas: inputData.personas,
      objections,
      openingsMarkdown: inputData.openingsMarkdown,
      rebuttalsMarkdown: inputData.rebuttalsMarkdown,
    };
  },
});
```

`replyStep`'s `inputSchema` therefore also takes `personas`, `openingsMarkdown`,
and `rebuttalsMarkdown` on top of the four fields shown above, and the `.map()`
in Step 2 passes them through from round two.

- [ ] **Step 2: Fan out to the named personas only**

After the `.foreach(rebuttalStep, { concurrency: 4 })` stage, map the round-two output into reply inputs. `personasNamedIn` returns an empty array when nobody objected, and `foreach` over an empty array runs nothing, so a unanimous board costs no round-three calls:

```ts
  .map(async ({ inputData }) => {
    const objections = inputData as unknown as Array<z.infer<typeof rebuttalEntrySchema>>;
    const first = objections[0];

    return personasNamedIn(objections).map((personaId) => ({
      personaId,
      question: first.question,
      threadId: first.threadId,
      objections,
    }));
  })
  .foreach(replyStep, { concurrency: 4 })
```

Round two's carried fields (`personas`, `openingsMarkdown`, `question`, `threadId`) are how the later steps still see round one; keep them on `rebuttalEntrySchema`. Because `replyEntrySchema` does not carry them, `renderDebateStep` cannot read them from its own input — so widen `replyEntrySchema` to carry `question`, `threadId`, `personas`, `openingsMarkdown`, `objections`, and `rebuttalsMarkdown` through, exactly as `rebuttalEntrySchema` already carries `openingsMarkdown`. Return them from `replyStep` unchanged.

- [ ] **Step 3: Render the debate**

Rename `renderRebuttalsStep` to `renderDebateStep` and give it all three rounds:

```ts
const renderDebateStep = createStep({
  id: "render-debate",
  inputSchema: z.array(replyEntrySchema),
  outputSchema: z.object({
    question: z.string(),
    threadId: z.string(),
    personas: z.array(personaTurnSchema),
    objections: z.array(rebuttalEntrySchema),
    replies: z.array(replyEntrySchema),
    openingsMarkdown: z.string(),
    rebuttalsMarkdown: z.string(),
    repliesMarkdown: z.string(),
  }),
  execute: async ({ inputData }) => {
    const first = inputData[0];
    const replies: ReplyEntry[] = inputData.map((entry) => ({
      personaId: entry.personaId,
      text: entry.text,
    }));

    return {
      question: first.question,
      threadId: first.threadId,
      personas: first.personas,
      objections: first.objections,
      replies,
      openingsMarkdown: first.openingsMarkdown,
      rebuttalsMarkdown: first.rebuttalsMarkdown,
      repliesMarkdown: renderReplyRound(replies),
    };
  },
});
```

An unopposed board produces an empty `inputData`, so guard it: if `inputData.length === 0`, the reply round is empty and the carried fields must come from the round-two output instead. Handle that by keeping a `.map()` before `renderDebateStep` that passes round two's array through when no replies were produced, rather than indexing `[0]` on an empty array.

- [ ] **Step 4: Type-check and run the workflow**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm exec tsc --noEmit`
Expected: no output.

Then start a run against a question the board reliably splits on and confirm round three fired:

```bash
RUN=$(curl -s -X POST http://localhost:4111/api/workflows/boardSession/create-run \
  -H "Content-Type: application/json" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['runId'])")
curl -s -X POST "http://localhost:4111/api/workflows/boardSession/start?runId=$RUN" \
  -H "Content-Type: application/json" \
  -d '{"inputData":{"question":"Our Q3 gross margin dropped 4 points to 58%. Should we cut marketing spend?","threadId":"t3-replies"}}' -o /dev/null
sleep 200
curl -s "http://localhost:4111/api/workflows/boardSession/runs/$RUN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result') or {}
print('status:', d.get('status'))
print('objections:', len(r.get('objections',[])))
print('replies:', [x['personaId'] for x in r.get('replies',[])])
"
```

Expected: `status: success`, at least one objection, and every persona in `replies` appearing in some objection's `with` list.

- [ ] **Step 5: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-server/src/mastra/workflows/board-session.ts
git commit -m "feat: add round three so objections get answered"
```

---

### Task 4: The chair and the single answer

**Files:**
- Create: `shadow-cabinet-server/src/mastra/agents/chair.ts`
- Create: `shadow-cabinet-server/src/mastra/agents/chair.test.ts`
- Modify: `shadow-cabinet-server/src/mastra/agents/index.ts`
- Modify: `shadow-cabinet-server/src/mastra/index.ts`
- Modify: `shadow-cabinet-server/src/mastra/workflows/board-session.ts`

**Interfaces:**
- Consumes: `companyDataTools`; the debate output from Task 3.
- Produces:
  - `chairAgent` with id `chair-agent`, exported from `agents/index.ts` and registered on the Mastra instance
  - `chairStep` — final workflow step
  - Workflow output becomes `{ answer: string; rounds: { personas, objections, replies }; transcript: string }`

- [ ] **Step 1: Write the failing test**

Create `shadow-cabinet-server/src/mastra/agents/chair.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { chairAgent } from "./chair.ts";

describe("the chair", () => {
  it("is not a board persona", () => {
    expect(chairAgent.id).toBe("chair-agent");
  });

  it("has the same grounding tools as the board", async () => {
    const tools = await chairAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      "compareMetricTool",
      "getMetricTool",
      "getSegmentMixTool",
      "listPeriodsTool",
    ]);
  });

  it("is told to commit to a recommendation and never to ask the CEO a question", async () => {
    const instructions = String(await chairAgent.getInstructions());
    expect(instructions).toMatch(/never ask the ceo/i);
    expect(instructions).toMatch(/flip/i);
    expect(instructions).toMatch(/never invent|never estimate/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm test chair`
Expected: FAIL — `Cannot find module './chair.ts'`.

- [ ] **Step 3: Write the chair**

Create `shadow-cabinet-server/src/mastra/agents/chair.ts`:

```ts
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";

import { companyDataTools } from "../tools/company-data-tools.ts";

/**
 * The chair is not a board member. It has no lens to argue from and never
 * takes part in the debate — it turns three rounds of argument into the one
 * answer the CEO actually reads.
 */
export const chairAgent = new Agent({
  id: "chair-agent",
  name: "CHAIR",
  instructions: `
You chair a virtual executive board. You do not have a lens of your own and you
never take a side for its own sake. You write the single answer the CEO reads.

## What you produce
- Lead with the recommendation, in one sentence, as a decision the CEO can act on.
- Then the reasoning, citing the figures the board actually fetched.
- Under 200 words.

## When the board agrees
State the recommendation and why it holds.

## When the board is split
Still commit to a recommendation. Then say the split out loud: name which
executives disagree, what each is optimising for, and what fact about the CEO's
own priorities would flip your recommendation the other way.

## Rules
- Never invent, estimate, or recall a number. Use the tools, or cite only
  figures the board already fetched in the debate you were given.
- Never ask the CEO a question. Never hand the decision back unmade. The CEO
  asked for an answer and gets one.
- Do not introduce a position nobody on the board argued.
`.trim(),
  model: "anthropic/claude-sonnet-4-5",
  tools: companyDataTools,
  memory: new Memory({ options: { lastMessages: 20 } }),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm test chair`
Expected: PASS — 3 tests.

- [ ] **Step 5: Register the chair**

In `agents/index.ts` add `export { chairAgent } from "./chair.ts";`. Do **not** add it to `PERSONAS`, `PERSONA_IDS`, or `boardAgents` — those drive the debate fan-outs, and the chair must never be fanned out to.

In `mastra/index.ts`, import it and add it to the `agents` map: `agents: { cfoAgent, cmoAgent, cooAgent, csoAgent, chairAgent }`.

- [ ] **Step 6: Add the chair step**

In `board-session.ts`, after `renderDebateStep`:

```ts
// Matches what `renderDebateStep` actually returns as of `a49968c`. Zod strips
// unknown keys, so the `transcript` it also returns passes through harmlessly.
const debateStateSchema = z.object({
  question: z.string(),
  threadId: z.string(),
  personas: z.array(personaTurnSchema),
  objections: z.array(objectionSchema),
  replies: z.array(replyTurnSchema),
  openingsMarkdown: z.string(),
  rebuttalsMarkdown: z.string(),
  repliesMarkdown: z.string(),
  transcript: z.string(),
});

const chairStep = createStep({
  id: "chair",
  inputSchema: debateStateSchema,
  outputSchema: z.object({
    answer: z.string(),
    question: z.string(),
    threadId: z.string(),
    personas: z.array(personaTurnSchema),
    objections: z.array(objectionSchema),
    replies: z.array(replyTurnSchema),
    transcript: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra.getAgentById("chair-agent");
    // Already assembled by `renderDebateStep`; rebuilding it here would let the
    // two drift.
    const { transcript } = inputData;

    const response = await agent.generate(
      `The CEO asked: "${inputData.question}"

Your board debated it:

${transcript}

Write the answer.`,
      { memory: { resource: "ceo", thread: inputData.threadId } },
    );

    return {
      answer: response.text,
      question: inputData.question,
      threadId: inputData.threadId,
      personas: inputData.personas,
      objections: inputData.objections,
      replies: inputData.replies,
      transcript,
    };
  },
});
```

Chain it last: `.then(renderDebateStep).then(chairStep).commit()`. Update the workflow's `outputSchema` to match `chairStep`'s.

- [ ] **Step 7: Verify the chair commits**

Run a contested question end to end as in Task 3 Step 4 and print `result.answer`. Expected: a recommendation in the first sentence, and where the board split, the phrase naming what would flip it. An answer that lists positions without recommending anything is a prompt failure — tighten the instructions, do not accept it.

- [ ] **Step 8: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-server/src/mastra/agents shadow-cabinet-server/src/mastra/index.ts shadow-cabinet-server/src/mastra/workflows/board-session.ts
git commit -m "feat: add the chair and make its answer the board's output"
```

---

### Task 5: Persist the answer, the rounds, and thread status

**Files:**
- Modify: `shadow-cabinet-server/src/mastra/data/board-sessions.ts`
- Modify: `shadow-cabinet-server/src/mastra/routes/board-history.ts`
- Modify: `shadow-cabinet-server/src/mastra/workflows/board-session.ts`

**Interfaces:**
- Consumes: `chairStep` output (Task 4); `getPendingRun` (existing).
- Produces:
  - `BoardSession` gains `answer: string`, `objections: BoardObjection[]`, `replies: BoardReply[]`
  - `type ThreadStatus = "running" | "waiting_on_ceo" | "resolved"`
  - `GET /board/:threadId/messages` returns `{ sessions, pending, status }`

- [ ] **Step 1: Widen the stored session**

In `data/board-sessions.ts`, add to the exported types and to `BoardSession`:

```ts
export interface BoardObjection {
  personaId: string;
  disagrees: boolean;
  with: string[];
  statement: string;
}

export interface BoardReply {
  personaId: string;
  text: string;
}

export type ThreadStatus = "running" | "waiting_on_ceo" | "resolved";
```

`BoardSession` becomes `{ threadId, question, answer, personas, objections, replies, createdAt }`. Delete `rebuttalsMarkdown` — the renderer now takes structured rounds, and keeping a second markdown copy invites the two to disagree.

- [ ] **Step 2: Save the whole session from the chair step**

Move the `saveBoardSession` call out of the old render step and into `chairStep`, after the answer comes back:

```ts
    await saveBoardSession({
      threadId: inputData.threadId,
      question: inputData.question,
      answer: response.text,
      personas: inputData.personas,
      objections: inputData.objections,
      replies: inputData.replies,
    });
```

- [ ] **Step 3: Serve the status**

In `routes/board-history.ts`, derive status from what is already stored rather than writing a fourth record: a pending run means `waiting_on_ceo`, otherwise any stored session means `resolved`, otherwise `running`.

```ts
    const status: ThreadStatus = pending
      ? "waiting_on_ceo"
      : sessions.length > 0
        ? "resolved"
        : "running";

    return c.json({
      sessions: sessions.map(({ question, answer, personas, objections, replies }) => ({
        question,
        answer,
        personas,
        objections,
        replies,
      })),
      pending,
      status,
    });
```

- [ ] **Step 4: Type-check and verify**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm exec tsc --noEmit`

Then, after one completed board on thread `t5-history`:

```bash
curl -s http://localhost:4111/board/t5-history/messages | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d['sessions'][0]
print('status:', d['status'])
print('answer starts:', s['answer'][:80])
print('objections:', len(s['objections']), 'replies:', len(s['replies']))
"
```

Expected: `status: resolved`, a non-empty answer, and counts matching the run.

- [ ] **Step 5: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-server/src/mastra
git commit -m "feat: persist the chair's answer, all three rounds, and thread status"
```

---

### Task 6: The proxy emits an answer and a debate part

**Files:**
- Create: `shadow-cabinet-web/lib/debate.ts`
- Modify: `shadow-cabinet-web/lib/board.ts`
- Modify: `shadow-cabinet-web/lib/board.test.ts`
- Modify: `shadow-cabinet-web/app/api/chat/route.ts`
- Modify: `shadow-cabinet-web/lib/history.ts` — pulled forward from Task 10, because `897ebb7` left it reading a field the server no longer sends

**Interfaces:**
- Consumes: the history route's `sessions` shape (Task 5); `runBoardSession`'s polling loop (existing).
- Produces:
  - `lib/debate.ts`: `type BoardDebate = { openings: BoardPersonaTurn[]; objections: BoardObjection[]; replies: BoardReply[] }`, `type BoardWaiting = { questions: CeoQuestion[] }`
  - `BoardOutcome` complete variant becomes `{ status: "complete"; answer: string; debate: BoardDebate }`
  - The stream emits, in order: `data-board-debate`, then the answer as text parts

- [ ] **Step 1: Write the failing test**

In `shadow-cabinet-web/lib/board.test.ts`, replace the success fixture's `result` with the new shape and add:

```ts
it("returns the chair's answer and the three rounds", async () => {
  const impl = async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/create-run")) {
      return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
    }
    if (href.includes("/start")) return new Response("{}", { status: 200 });

    return new Response(
      JSON.stringify({
        status: "success",
        result: {
          answer: "Hold the spend.",
          personas: [{ personaId: "cfo", text: "Cut.", evidence: [] }],
          objections: [
            { personaId: "cmo", disagrees: true, with: ["cfo"], statement: "Pipeline." },
          ],
          replies: [{ personaId: "cfo", text: "Payback is 14 months." }],
        },
      }),
      { status: 200 },
    );
  };

  const board = await runBoardSession({
    baseUrl: "http://board",
    question: "Should we cut spend?",
    threadId: "board-1",
    fetchImpl: impl,
    pollIntervalMs: 0,
  });

  if (board.status !== "complete") throw new Error("expected a completed board");
  expect(board.answer).toBe("Hold the spend.");
  expect(board.debate.objections[0].with).toEqual(["cfo"]);
  expect(board.debate.replies[0].personaId).toBe("cfo");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm test board`
Expected: FAIL — `board.answer` is undefined.

- [ ] **Step 3: Reshape the outcome**

Create `shadow-cabinet-web/lib/debate.ts` with the three types above, then in `lib/board.ts` replace the `status === "success"` branch:

```ts
    if (status === "success") {
      const { answer, personas, objections, replies } = snapshot.result ?? {};
      if (!answer) {
        throw new Error("Board run succeeded but the chair returned no answer.");
      }
      return {
        status: "complete",
        answer,
        debate: {
          openings: personas ?? [],
          objections: objections ?? [],
          replies: replies ?? [],
        },
      };
    }
```

Delete `transcript` and `rebuttalsMarkdown` from `BoardResult` and from `RunSnapshot["result"]`. Keep `onRoundOne` — it still fires from `steps["render-openings"].output.personas` and is what Task 7 renders early.

- [ ] **Step 4: Emit the parts**

In `app/api/chat/route.ts`, delete `writeOpenings` and `waitingMarkdown`. The debate goes out as one data part and the answer as text:

```ts
        if (board.status === "waiting") {
          write({
            type: "data-board-waiting",
            id: "board-waiting",
            data: { questions: board.questions },
          });
        } else {
          write({
            type: "data-board-debate",
            id: "board-debate",
            data: board.debate,
          });

          const id = "board-answer";
          write({ type: "text-start", id });
          write({ type: "text-delta", id, delta: board.answer });
          write({ type: "text-end", id });
        }
```

The debate part is written **before** the answer text so the renderer can place it beneath the answer by layout rather than by arrival order — parts render in stream order, and the answer must be the thing the eye lands on first, so the component in Task 7 is responsible for the visual order.

`onRoundOne` keeps its job: it now emits an early `data-board-debate` carrying only `openings`, with empty `objections` and `replies`, so the CEO sees positions while rounds two and three run. The final part with the same `id` replaces it.

- [ ] **Step 5: Run the tests**

Run: `cd /Users/abhishekkolge/projects/shadow-cabinet && pnpm test board`
Expected: PASS.

- [ ] **Step 6: Verify the wire format**

```bash
curl -s -N -m 900 -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"threadId":"t6-parts","messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"Should we cut marketing spend to defend margin?"}]}]}' \
  | grep -o '"type":"[a-z-]*"' | sort | uniq -c
```

Expected: one `data-board-debate` (or two, with the early one), one `text-start`, and no `tool-input-available` — evidence now travels inside the debate part, not as tool parts.

- [ ] **Step 7: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-web/lib shadow-cabinet-web/app/api/chat/route.ts
git commit -m "feat: stream the chair's answer with the debate as a data part"
```

---

### Task 7: The debate section

**Files:**
- Create: `shadow-cabinet-web/components/assistant-ui/board-debate.tsx`
- Modify: `shadow-cabinet-web/components/assistant-ui/thread.tsx`

**Interfaces:**
- Consumes: `BoardDebate` from `lib/debate.ts`; `PERSONA_TITLES` from `lib/personas.ts`; `ToolGroupRoot`, `ToolGroupTrigger`, `ToolGroupContent` from `./tool-group.tsx`.
- Produces: `BoardDebateSection` — a `DataMessagePartComponent` registered for `board-debate`.

- [ ] **Step 1: Confirm the registration API**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet/shadow-cabinet-web
grep -rn "useAssistantDataUI\|DataMessagePartComponent" node_modules/@assistant-ui/core/dist/react/*.d.ts | head -5
```

Read the signature before writing the component. `thread.tsx` already routes `case "data": return part.dataRendererUI;`, so registration is what supplies `dataRendererUI` — do not add a new switch case.

- [ ] **Step 2: Build the section**

Create `shadow-cabinet-web/components/assistant-ui/board-debate.tsx`. Three labelled sections, each objection and reply naming its target, and each persona's evidence collapsed inside its own opening:

```tsx
"use client";

import { useState } from "react";

import type { BoardDebate } from "@/lib/debate";
import { PERSONA_TITLES } from "@/lib/personas";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";

function title(personaId: string) {
  return `${personaId.toUpperCase()} — ${PERSONA_TITLES[personaId] ?? personaId}`;
}

export function BoardDebateSection({
  data,
  defaultOpen,
}: {
  data: BoardDebate;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="my-3 rounded-lg border" data-slot="aui_board-debate">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-muted-foreground hover:text-foreground w-full px-4 py-2 text-start text-xs font-medium"
      >
        {open ? "Hide the debate" : "Show the debate"}
      </button>

      {open && (
        <div className="space-y-4 px-4 pb-4 text-sm">
          <h3 className="text-xs font-semibold uppercase">Opening positions</h3>
          {data.openings.map((persona) => (
            <div key={persona.personaId} className="space-y-1">
              <p className="font-medium">{title(persona.personaId)}</p>
              <p className="whitespace-pre-wrap">{persona.text}</p>
              {persona.evidence.length > 0 && (
                <ToolGroupRoot variant="ghost">
                  <ToolGroupTrigger
                    count={persona.evidence.length}
                    label={`Checked ${persona.evidence.length} ${
                      persona.evidence.length === 1 ? "figure" : "figures"
                    }`}
                  />
                  <ToolGroupContent>
                    <ul className="text-muted-foreground list-disc ps-5 text-xs">
                      {persona.evidence.map((call) => (
                        <li key={call.toolCallId}>
                          <code>{call.toolName}</code> {JSON.stringify(call.input)}
                        </li>
                      ))}
                    </ul>
                  </ToolGroupContent>
                </ToolGroupRoot>
              )}
            </div>
          ))}

          <h3 className="text-xs font-semibold uppercase">Where the board disagreed</h3>
          {data.objections.filter((o) => o.disagrees && o.statement.trim()).length === 0 ? (
            <p className="text-muted-foreground">The board did not disagree.</p>
          ) : (
            data.objections
              .filter((o) => o.disagrees && o.statement.trim())
              .map((objection) => (
                <div key={objection.personaId} className="space-y-1">
                  <p className="font-medium">
                    {objection.personaId.toUpperCase()} → {objection.with.map((w) => w.toUpperCase()).join(", ")}
                  </p>
                  <p className="whitespace-pre-wrap">{objection.statement}</p>
                </div>
              ))
          )}

          <h3 className="text-xs font-semibold uppercase">Replies</h3>
          {data.replies.length === 0 ? (
            <p className="text-muted-foreground">No replies were needed.</p>
          ) : (
            data.replies.map((reply) => (
              <div key={reply.personaId} className="space-y-1">
                <p className="font-medium">{reply.personaId.toUpperCase()} replies</p>
                <p className="whitespace-pre-wrap">{reply.text}</p>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Open by default on a thread's first answer**

Create `shadow-cabinet-web/lib/use-debate-open.ts`. Absence of a stored value
means open, which is what makes a thread's first answer show the argument:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";

const key = (threadId: string) => `shadow-cabinet:debate:${threadId}`;

/**
 * Open on a thread's first answer, then whatever the CEO last chose. Reads on
 * mount rather than during render: `localStorage` does not exist on the server,
 * and touching it during render makes the first client paint disagree with the
 * server's, which React reports as a hydration error.
 */
export function useDebateOpen(threadId: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const stored = window.localStorage.getItem(key(threadId));
    if (stored !== null) setOpen(stored === "open");
  }, [threadId]);

  const choose = useCallback(
    (next: boolean) => {
      setOpen(next);
      window.localStorage.setItem(key(threadId), next ? "open" : "closed");
    },
    [threadId],
  );

  return [open, choose];
}
```

`BoardDebateSection` then takes `threadId` instead of `defaultOpen` and calls
this hook, replacing its local `useState`. Its toggle calls `choose(!open)`.

- [ ] **Step 4: Register it**

Signature verified against `@assistant-ui/core@0.3.9`:

```ts
declare const useAssistantDataUI: (dataUI: { name: string; render: DataMessagePartComponent } | null) => void;
type DataMessagePartProps<T> = MessagePartState & { type: "data"; name: string; data: T };
```

Two details that are easy to get wrong and are not guesses:

- `name` is the **bare** name, `"board-debate"`, not `"data-board-debate"`. The
  wire format is `data-<name>`; the runtime part is `{ type: "data", name, data }`
  with the prefix already stripped.
- The hook registers one renderer per call, so call it twice.

Create `shadow-cabinet-web/components/assistant-ui/board-data-ui.tsx`:

```tsx
"use client";

import { useAssistantDataUI } from "@assistant-ui/react";

import type { BoardDebate, BoardWaiting } from "@/lib/debate";
import { BoardDebateSection } from "@/components/assistant-ui/board-debate";
import { BoardWaitingNotice } from "@/components/assistant-ui/board-waiting";

/**
 * Registers the board's data renderers for as long as it is mounted. Rendered
 * inside AssistantRuntimeProvider — the hook writes into runtime context, so it
 * throws outside one.
 */
export function BoardDataUI({ threadId }: { threadId: string }) {
  useAssistantDataUI({
    name: "board-debate",
    render: ({ data }: { data: BoardDebate }) => (
      <BoardDebateSection data={data} threadId={threadId} />
    ),
  });

  useAssistantDataUI({
    name: "board-waiting",
    render: ({ data }: { data: BoardWaiting }) => <BoardWaitingNotice data={data} />,
  });

  return null;
}
```

Mount it in `app/assistant.tsx` as the first child of `AssistantRuntimeProvider`,
above `SidebarProvider`: `<BoardDataUI threadId={threadId} />`.

`thread.tsx` already routes `case "data": return part.dataRendererUI;` — leave
that switch alone. Registration is what fills `dataRendererUI`.

- [ ] **Step 5: Verify in the browser**

Start both servers, open a thread, ask a contested question. Expected: the chair's answer as the message body, the debate section beneath it, open on first answer, with three labelled sections and per-persona evidence that collapses independently. Collapse it, reload, and confirm it stays collapsed for that thread.

- [ ] **Step 6: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-web/components/assistant-ui
git commit -m "feat: render the debate beneath the answer as a collapsible section"
```

---

### Task 8: The waiting screen

**Files:**
- Create: `shadow-cabinet-web/components/assistant-ui/board-waiting.tsx`
- Modify: `shadow-cabinet-web/app/board/[threadId]/page.tsx`

**Interfaces:**
- Consumes: `BoardWaiting` from `lib/debate.ts`; `PERSONA_IDS`-equivalent list from `lib/personas.ts`; the history route's `status` (Task 5).
- Produces: `BoardWaitingNotice` — a `DataMessagePartComponent` for `board-waiting`.

- [ ] **Step 1: Build the notice**

All four personas visible and visibly paused, the ones that asked highlighted with their question, per the spec. It should read as a room waiting on you:

```tsx
"use client";

import type { BoardWaiting } from "@/lib/debate";
import { PERSONA_TITLES } from "@/lib/personas";

export function BoardWaitingNotice({ data }: { data: BoardWaiting }) {
  const asked = new Map(data.questions.map((q) => [q.personaId, q.question]));

  return (
    <section className="border-amber-500/40 bg-amber-500/5 my-3 rounded-lg border p-4">
      <p className="text-sm font-semibold">The board is waiting on you</p>
      <ul className="mt-3 space-y-3">
        {Object.keys(PERSONA_TITLES).map((personaId) => (
          <li key={personaId} className="text-sm">
            <span className={asked.has(personaId) ? "font-medium" : "text-muted-foreground"}>
              {personaId.toUpperCase()} — {PERSONA_TITLES[personaId]}
            </span>
            {asked.has(personaId) ? (
              <p className="mt-1">{asked.get(personaId)}</p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">waiting</p>
            )}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-3 text-xs">
        Answer below and the board continues from where it stopped.
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Land a returning CEO on the same state**

The seeded message uses the **wire** shape, `type: "data-board-waiting"` —
`UIMessage` parts carry the prefix; only the runtime part drops it. Verified
against `ai@7`: `type DataUIPart = { type: \`data-${NAME}\`; id?: string; data }`.

In `lib/history.ts`, widen the fetch to return the pending questions too:

```ts
export interface BoardHistory {
  messages: UIMessage[];
  status: "running" | "waiting_on_ceo" | "resolved";
}

export async function fetchBoardHistory(
  baseUrl: string,
  threadId: string,
): Promise<BoardHistory> {
  try {
    const response = await fetch(`${baseUrl}/board/${threadId}/messages`, {
      cache: "no-store",
    });
    if (!response.ok) return { messages: [], status: "running" };

    const { sessions, pending, status } = (await response.json()) as {
      sessions?: BoardHistorySession[];
      pending?: { questions: CeoQuestion[] } | null;
      status?: BoardHistory["status"];
    };

    const messages = historyToMessages(sessions ?? []);

    // A thread stopped mid-question reopens into the room that is waiting.
    if (status === "waiting_on_ceo" && pending) {
      messages.push({
        id: "history-waiting",
        role: "assistant",
        parts: [
          {
            type: "data-board-waiting",
            id: "board-waiting",
            data: { questions: pending.questions },
          } as UIMessage["parts"][number],
        ],
      });
    }

    return { messages, status: status ?? "running" };
  } catch {
    return { messages: [], status: "running" };
  }
}
```

`app/board/[threadId]/page.tsx` then reads `.messages`:

```tsx
  const { messages } = await fetchBoardHistory(MASTRA_API_URL, threadId);

  return <Assistant threadId={threadId} initialMessages={messages} />;
```

- [ ] **Step 3: Verify**

Ask the acquisition question (`"A competitor has offered to acquire our Freight Brokerage unit. Should we sell it?"`), which reliably blocks the board. Expected: the waiting notice with the asking personas highlighted. Reload the page and confirm it is still there. Answer it and confirm the board resumes and ends with an answer.

- [ ] **Step 4: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-web
git commit -m "feat: make the waiting-on-CEO state a real screen"
```

---

### Task 9: Addressing one persona

**Files:**
- Modify: `shadow-cabinet-web/app/assistant.tsx`
- Modify: `shadow-cabinet-web/app/api/chat/route.ts`
- Modify: `shadow-cabinet-web/lib/personas.ts`

**Interfaces:**
- Consumes: Mastra's existing `chatRoute` at `POST /chat/:agentId`, already registered in `mastra/index.ts`.
- Produces: `target` on the chat request body — `"board"` (default) or a `PersonaId`.

- [ ] **Step 1: Add the selector**

**Plan correction, verified:** the composer is not in `assistant.tsx`. It lives
in `components/assistant-ui/thread.tsx` at `ComposerPrimitive.Root` (~line 214),
rendered by `<Thread />`. The selector goes there, and the choice has to reach
`assistant.tsx`, which owns the transport — so it travels through context, not
props.

Create `shadow-cabinet-web/lib/board-target.tsx`:

```tsx
"use client";

import { createContext, useContext, useState } from "react";

export type BoardTarget = "board" | "cfo" | "cmo" | "coo" | "cso";

const BoardTargetContext = createContext<{
  target: BoardTarget;
  setTarget: (target: BoardTarget) => void;
}>({ target: "board", setTarget: () => {} });

export function BoardTargetProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<BoardTarget>("board");

  return (
    <BoardTargetContext value={{ target, setTarget }}>{children}</BoardTargetContext>
  );
}

export const useBoardTarget = () => useContext(BoardTargetContext);
```

In `thread.tsx`, inside `ComposerPrimitive.Root` and beside `<ComposerAction />`:

```tsx
const ComposerTarget: FC = () => {
  const { target, setTarget } = useBoardTarget();

  return (
    <select
      aria-label="Who answers"
      value={target}
      onChange={(event) => setTarget(event.target.value as BoardTarget)}
      className="text-muted-foreground bg-transparent text-xs outline-none"
    >
      <option value="board">Whole board</option>
      {Object.entries(PERSONA_TITLES).map(([id, title]) => (
        <option key={id} value={id}>
          {id.toUpperCase()} — {title}
        </option>
      ))}
    </select>
  );
};
```

In `assistant.tsx`, wrap the tree in `BoardTargetProvider`, then read the target
where the runtime is built. `useChatRuntime` captures `body` once, so a plain
value would freeze on "board"; send a function-free snapshot by moving the
transport into a child component that re-creates it when the target changes, or
read the target inside `prepareSendMessagesRequest` if the installed
`AssistantChatTransport` exposes it. Confirm which before writing:

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet/shadow-cabinet-web
grep -rn "prepareSendMessagesRequest\|body" node_modules/@assistant-ui/react-ai-sdk/dist/ui/use-chat/AssistantChatTransport.d.ts | head
```

Prefer whichever the type supports; do not assume `body` re-reads on every send.

- [ ] **Step 2: Route a targeted message**

In the proxy, when `target !== "board"`, skip reception, skip `pendingRunId`, and skip the workflow entirely — the spec says a targeted message calls only that agent and skips the debate and the chair. Proxy Mastra's own agent stream straight through, since a single agent's stream already carries text and tool-call parts and assistant-ui's chain-of-thought card renders them:

```ts
  if (target !== "board") {
    const upstream = await fetch(`${MASTRA_API_URL}/chat/${target}-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, memory: { resource: "ceo", thread: threadId } }),
      signal: req.signal,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    });
  }
```

Verify the body `chatRoute` expects before writing this — `sendReasoning: true` is already set on it in `mastra/index.ts`, and it may want `memory` at the top level or nested.

- [ ] **Step 3: Verify**

Select CFO, ask "What was gross margin in 2025-Q3?". Expected: a single CFO reply in seconds, with its own evidence card, no debate section, no chair answer. Switch back to "Whole board" and confirm the full session still runs.

- [ ] **Step 4: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-web
git commit -m "feat: let the CEO address a single executive"
```

---

### Task 10: Rehydration and the write-up

**Files:**
- Modify: `shadow-cabinet-web/lib/history.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the history route's `{ sessions, pending, status }` (Task 5); `BoardDebate` (Task 6).
- Produces: `historyToMessages` returns assistant messages carrying a `board-debate` data part plus the answer as text.

- [ ] **Step 1: Rebuild past sessions in the new shape**

Replace the body of `historyToMessages` so each stored session becomes a user message with the question and an assistant message whose parts are `[{ type: "data-board-debate", id, data: { openings, objections, replies } }, { type: "text", text: answer }]`. Delete the per-persona `tool-*` parts — evidence now lives inside the debate part.

- [ ] **Step 2: Verify**

Reopen a thread that already has a completed session. Expected: the answer and the debate section, identical to the live run that produced it.

- [ ] **Step 3: Rewrite the README design write-up**

The current write-up describes two passes, no chair, and four positions as the output. Rewrite these sections against the shipped board: three rounds closed by a chair that always commits and names the flip condition; the CEO interrupt as a round-one-only halt that resumes without re-running round one, with the CEO's answer scoped to its thread; the answer-led UI with the debate beneath it; single-persona addressing; and the reception gate that answers greetings without convening the board. Keep the grounding and persona sections — they are still accurate.

Add to "what production would need next": promoting a CEO's spoken answer into a durable company fact, which this build deliberately leaves out.

- [ ] **Step 4: Full verification**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
pnpm test
pnpm exec tsc --noEmit
cd shadow-cabinet-web && pnpm exec tsc --noEmit
```

Expected: all tests pass, no type errors in either package.

- [ ] **Step 5: Commit**

```bash
cd /Users/abhishekkolge/projects/shadow-cabinet
git add shadow-cabinet-web/lib/history.ts README.md
git commit -m "docs: rewrite the design write-up around the chair and the interrupt"
```

---

## Verification Checklist

Run before considering the plan complete:

- [ ] `pnpm test` — all tests pass
- [ ] `pnpm exec tsc --noEmit` — clean in both packages
- [ ] A contested question returns one chair answer that commits to a recommendation
- [ ] Where the board splits, the answer names the flip condition
- [ ] The debate section shows three labelled rounds, open on a thread's first answer, and its collapsed state survives a reload
- [ ] Every persona in `replies` was named in some objection's `with` list
- [ ] The acquisition question halts the board, names who asked what, and resumes on an answer without re-running round one
- [ ] A reopened thread renders the answer and debate identically to the live run
- [ ] Targeting one persona skips the debate and the chair
- [ ] "hi" still answers without convening the board
- [ ] Every figure quoted in an answer exists in `company-data.json`

## Known Risks

**Structured output on round one.** Task 2 asks each persona for `{ position, questionForCeo }` in the same call that uses tools. The rebuttal step already does this successfully, but openings are the longest prose the board produces and structure may flatten them. If the positions get noticeably worse, split into two calls — prose first, then a cheap `questionForCeo` extraction on that persona's own text only, which is still the agent judging itself rather than a classifier reading the room.

**Empty round three.** `foreach` over an empty array is the unopposed-board path, and `renderDebateStep` indexes `inputData[0]`. Task 3 Step 3 calls this out; if it is missed, a unanimous board crashes the run at the last step.

**`saveMessages` shape.** Task 2 Step 3 writes the CEO's answer directly into thread memory. The signature is verified inline, but if the installed version does not expose a usable write, the fallback is to pass the answer forward in workflow state and prepend it to the round-two prompt — worse, because only round two would see it, but it keeps the interrupt working.

**Cost.** A contested board is now nine agent calls plus round three plus the chair, and the resume path adds more. Sessions already run past nine minutes; `maxDuration` is 800 and serverless platforms cap well below that. Deployment stays a known limitation, not something this plan fixes.
