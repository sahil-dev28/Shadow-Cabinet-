import type { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { PERSONA_IDS, type PersonaId } from "../agents/index.ts";
import { listBoardSessions, saveBoardSession } from "../data/board-sessions.ts";
import { clearPendingRun, savePendingRun } from "../data/pending-runs.ts";
import {
  type OpeningEntry,
  type ReplyEntry,
  formatObjectionsForReply,
  formatOpeningsForRebuttal,
  personasNamedIn,
  renderOpeningRound,
  renderRebuttalRound,
  renderReplyRound,
} from "./transcript.ts";

const personaIdSchema = z.enum(PERSONA_IDS as unknown as [PersonaId, ...PersonaId[]]);

const boardInputSchema = z.object({
  question: z.string().min(1),
  threadId: z.string().min(1),
});

/**
 * One grounding call behind a persona's numbers. It has to survive as workflow
 * output; the browser never sees the agent's own stream.
 */
const evidenceSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown(),
});

const openingEntrySchema = z.object({
  personaId: personaIdSchema,
  text: z.string(),
  evidence: z.array(evidenceSchema),
  questionForCeo: z.string(),
  question: z.string(),
  threadId: z.string(),
});

const personaTurnSchema = z.object({
  personaId: personaIdSchema,
  text: z.string(),
  evidence: z.array(evidenceSchema),
});

interface ToolCallEnvelope {
  payload?: {
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
  };
}

/**
 * A guardrail block is not an exception: `generate()` resolves normally with
 * `tripwire` set and empty text, which would render as "had no view".
 */
function tripwireNotice(
  personaId: PersonaId,
  response: { tripwire?: { reason?: string } },
): string | null {
  if (!response.tripwire) return null;

  const reason = response.tripwire.reason?.trim() || "input blocked by a guardrail";
  return `_${personaId.toUpperCase()} is unavailable for this round: ${reason}._`;
}

/**
 * An executive that threw is reported the same way as one a guardrail blocked:
 * named, absent, and with the reason. `.foreach` fails the whole run if a step
 * throws, so one persona timing out would otherwise cost the CEO the other
 * three — the board is worth more with a gap in it than not at all.
 */
function personaUnavailable(personaId: PersonaId, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);

  return `_${personaId.toUpperCase()} is unavailable for this round: ${reason}._`;
}

/** Pairs Mastra's separate toolCalls/toolResults arrays back into one record. */
function collectEvidence(response: {
  toolCalls?: readonly ToolCallEnvelope[];
  toolResults?: readonly ToolCallEnvelope[];
}): Array<z.infer<typeof evidenceSchema>> {
  const outputs = new Map<string, unknown>();
  for (const entry of response.toolResults ?? []) {
    if (entry.payload?.toolCallId) {
      outputs.set(entry.payload.toolCallId, entry.payload.result);
    }
  }

  return (response.toolCalls ?? []).flatMap((entry) => {
    const { toolCallId, toolName, args } = entry.payload ?? {};
    if (!toolCallId || !toolName) return [];

    return [
      {
        toolCallId,
        toolName,
        input: (args ?? {}) as Record<string, unknown>,
        output: outputs.get(toolCallId) ?? null,
      },
    ];
  });
}

/**
 * What one persona said about another's position, and nothing else. Round three
 * hands this to four repliers at once, so the round-one state `rebuttalStep`
 * carries alongside it is stripped first rather than copied sixteen times.
 */
const objectionSchema = z.object({
  personaId: personaIdSchema,
  disagrees: z.boolean(),
  with: z.array(personaIdSchema),
  statement: z.string(),
});

const rebuttalEntrySchema = objectionSchema.extend({
  // Carried through the second fan-out: `workflowRoute` does not forward writer
  // output, so the transcript survives as workflow output, not stream text.
  openingsMarkdown: z.string(),
  personas: z.array(personaTurnSchema),
  question: z.string(),
  threadId: z.string(),
});

/** The shape pass two asks each persona to return. */
const verdictSchema = z.object({
  disagrees: z
    .boolean()
    .describe("True only if you have a substantive objection to another executive's position."),
  with: z
    .array(personaIdSchema)
    .describe("The persona ids you are objecting to. Empty if disagrees is false."),
  statement: z
    .string()
    .describe("Your objection, under 120 words. Empty string if disagrees is false."),
});

const ceoQuestionSchema = z.object({
  personaId: personaIdSchema,
  question: z.string(),
});

/**
 * The position and the question come back in one call, so an executive that is
 * blocked costs nothing extra — and the question is the one it actually has,
 * not one inferred from its prose after the fact.
 */
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

/** Pass one: one persona answers the CEO without seeing its peers. */
export const openingStep = createStep({
  id: "opening",
  inputSchema: z.object({
    personaId: personaIdSchema,
    question: z.string(),
    threadId: z.string(),
  }),
  outputSchema: openingEntrySchema,
  execute: async ({ inputData, mastra }) => {
    const { personaId, question, threadId } = inputData;

    try {
      const agent = mastra.getAgentById(`${personaId}-agent`);

      const response = await agent.generate(question, {
        memory: { resource: "ceo", thread: threadId },
        structuredOutput: { schema: openingOutputSchema },
      });

      const blocked = tripwireNotice(personaId, response);
      const opening = response.object ?? {
        position: response.text,
        questionForCeo: "",
      };

      // Structured output occasionally returns an empty `position` while still
      // making its tool calls, which renders as an executive with evidence and
      // no opinion. The prose it did produce is a better answer than a blank.
      const position = opening.position?.trim() || response.text;

      return {
        personaId,
        text: blocked ?? position,
        evidence: blocked ? [] : collectEvidence(response),
        questionForCeo: blocked ? "" : opening.questionForCeo.trim(),
        question,
        threadId,
      };
    } catch (error) {
      return {
        personaId,
        text: personaUnavailable(personaId, error),
        evidence: [],
        questionForCeo: "",
        question,
        threadId,
      };
    }
  },
});

const renderOpeningsStep = createStep({
  id: "render-openings",
  inputSchema: z.array(openingEntrySchema),
  outputSchema: z.object({
    question: z.string(),
    threadId: z.string(),
    openings: z.array(z.object({ personaId: personaIdSchema, text: z.string() })),
    openingsMarkdown: z.string(),
    personas: z.array(personaTurnSchema),
    ceoQuestions: z.array(ceoQuestionSchema),
  }),
  execute: async ({ inputData, writer }) => {
    const openings: OpeningEntry[] = inputData.map((entry) => ({
      personaId: entry.personaId,
      text: entry.text,
    }));

    const personas = inputData.map((entry) => ({
      personaId: entry.personaId,
      text: entry.text,
      evidence: entry.evidence,
    }));

    // Every executive that asked is carried forward. Batching them into one
    // pause is the pause's job, not a filter applied here.
    const ceoQuestions = inputData
      .filter((entry) => entry.questionForCeo.length > 0)
      .map((entry) => ({
        personaId: entry.personaId,
        question: entry.questionForCeo,
      }));

    // Stream the whole round at once so the sections cannot interleave.
    const openingsMarkdown = renderOpeningRound(openings);
    await writer?.write(openingsMarkdown);

    return {
      question: inputData[0].question,
      threadId: inputData[0].threadId,
      openings,
      openingsMarkdown,
      personas,
      ceoQuestions,
    };
  },
});

const roundOneStateSchema = z.object({
  question: z.string(),
  threadId: z.string(),
  openings: z.array(z.object({ personaId: personaIdSchema, text: z.string() })),
  openingsMarkdown: z.string(),
  personas: z.array(personaTurnSchema),
  ceoQuestions: z.array(ceoQuestionSchema),
});

/**
 * Halts the board when an executive needs something only the CEO can supply.
 * Questions are batched into one pause rather than asked one at a time, and the
 * answer is written back into the shared thread so every persona sees it.
 */
export const ceoPauseStep = createStep({
  id: "ceo-question",
  inputSchema: roundOneStateSchema,
  outputSchema: roundOneStateSchema,
  suspendSchema: z.object({ questions: z.array(ceoQuestionSchema) }),
  resumeSchema: z.object({ answer: z.string() }),
  execute: async ({ inputData, resumeData, suspend, mastra, runId }) => {
    if (inputData.ceoQuestions.length === 0) return inputData;

    if (!resumeData?.answer) {
      // Recorded before suspending so the CEO's next message resumes this run
      // rather than convening a second board on the same thread.
      await savePendingRun({
        threadId: inputData.threadId,
        runId,
        questions: inputData.ceoQuestions,
      });

      // `suspend()` halts the run; its return type is the step's, so the cast
      // through unknown just satisfies the signature on a path that never
      // produces a value.
      return (await suspend({
        questions: inputData.ceoQuestions,
      })) as unknown as typeof inputData;
    }

    await clearPendingRun(inputData.threadId);

    // Round one is not re-run. The answer goes into the thread every persona
    // shares, so the agent that asked reads it on its next turn, and the three
    // that already answered keep the answers the CEO has been looking at.
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
  },
});

/** Pass two: this persona reads the others and says whether it objects. */
export const rebuttalStep = createStep({
  id: "rebuttal",
  inputSchema: z.object({
    personaId: personaIdSchema,
    question: z.string(),
    threadId: z.string(),
    openings: z.array(z.object({ personaId: personaIdSchema, text: z.string() })),
    openingsMarkdown: z.string(),
    personas: z.array(personaTurnSchema),
  }),
  outputSchema: rebuttalEntrySchema,
  execute: async ({ inputData, mastra }) => {
    const { personaId, question, threadId, openings, openingsMarkdown, personas } =
      inputData;

    const others = formatOpeningsForRebuttal(openings, personaId);

    let response;
    try {
      const agent = mastra.getAgentById(`${personaId}-agent`);

      response = await agent.generate(
      `The CEO asked: "${question}"

Your fellow executives answered:

${others}

Do you have a substantive objection to any of those positions? Only say yes if
you genuinely disagree on the decision or the reasoning. Agreeing with a
different emphasis is not a disagreement. If you object, name who and say why,
citing figures you have fetched.`,
        {
          memory: { resource: "ceo", thread: threadId },
          structuredOutput: { schema: verdictSchema },
        },
      );
    } catch (error) {
      // Surfaced as a disagreement entry so the absence is visible, rather than
      // silently counting as "no objection" and skewing the round.
      return {
        personaId,
        disagrees: true,
        with: [] as PersonaId[],
        statement: personaUnavailable(personaId, error),
        openingsMarkdown,
        personas,
        question,
        threadId,
      };
    }

    // A blocked rebuttal is surfaced as a disagreement entry so the reader sees
    // the persona was silenced, not that it declined to object.
    const blocked = tripwireNotice(personaId, response);
    const verdict = blocked
      ? { disagrees: true, with: [] as PersonaId[], statement: blocked }
      : (response.object ?? { disagrees: false, with: [], statement: "" });

    return { personaId, ...verdict, openingsMarkdown, personas, question, threadId };
  },
});

/**
 * Everything round three needs, for one replier. `foreach` hands the next step
 * only what its items return, so rounds one and two ride along here or they do
 * not survive to be rendered. A null `personaId` is the unopposed board — see
 * `toReplyInputs`.
 */
const replyInputSchema = z.object({
  personaId: personaIdSchema.nullable(),
  question: z.string(),
  threadId: z.string(),
  personas: z.array(personaTurnSchema),
  objections: z.array(objectionSchema),
  openingsMarkdown: z.string(),
  rebuttalsMarkdown: z.string(),
});

const replyEntrySchema = replyInputSchema.extend({ text: z.string() });

/** A reply as the CEO reads it, without the state it carried to get here. */
const replyTurnSchema = z.object({
  personaId: personaIdSchema,
  text: z.string(),
});

/**
 * Round three only calls the personas an objection actually named — usually one
 * or two, not four.
 *
 * When nobody was named the fan-out would be empty, and `foreach` over an empty
 * array runs nothing, which would leave `renderDebateStep` with no round-two
 * state to render and no way to know what the board had been asked. So a
 * unanimous board sends one persona-less item through instead: `replyStep`
 * returns it without calling a model, so the round still costs nothing.
 */
export function toReplyInputs(
  entries: Array<z.infer<typeof rebuttalEntrySchema>>,
): Array<z.infer<typeof replyInputSchema>> {
  const first = entries[0];
  const objections = entries.map(
    ({ personaId, disagrees, with: targets, statement }) => ({
      personaId,
      disagrees,
      with: targets,
      statement,
    }),
  );

  const carried = {
    question: first.question,
    threadId: first.threadId,
    personas: first.personas,
    objections,
    openingsMarkdown: first.openingsMarkdown,
    rebuttalsMarkdown: renderRebuttalRound(objections),
  };

  const named = personasNamedIn(objections);
  if (named.length === 0) return [{ personaId: null, ...carried }];

  return named.map((personaId) => ({ personaId, ...carried }));
}

/** Pass three: defend or concede, nothing else. */
export const replyStep = createStep({
  id: "reply",
  inputSchema: replyInputSchema,
  outputSchema: replyEntrySchema,
  execute: async ({ inputData, mastra }) => {
    const { personaId, question, threadId, objections } = inputData;

    if (personaId === null) return { ...inputData, text: "" };

    try {
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

      return { ...inputData, text: blocked ?? response.text };
    } catch (error) {
      // One executive failing to answer for itself is worth less than the
      // round: the objection stands unanswered and the board still finishes.
      return { ...inputData, text: personaUnavailable(personaId, error) };
    }
  },
});

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

export const renderDebateStep = createStep({
  id: "render-debate",
  inputSchema: z.array(replyEntrySchema),
  outputSchema: debateStateSchema,
  execute: async ({ inputData, writer }) => {
    // Never empty: `toReplyInputs` sends a placeholder through when nobody was
    // objected to, so a unanimous board still arrives here carrying its state.
    const first = inputData[0];

    const replies: ReplyEntry[] = inputData.flatMap((entry) =>
      entry.personaId === null
        ? []
        : [{ personaId: entry.personaId, text: entry.text }],
    );

    const repliesMarkdown = renderReplyRound(replies);

    // Both rounds go out in one write so their sections cannot interleave.
    await writer?.write(`\n${first.rebuttalsMarkdown}\n${repliesMarkdown}`);

    return {
      question: first.question,
      threadId: first.threadId,
      personas: first.personas,
      objections: first.objections,
      replies,
      openingsMarkdown: first.openingsMarkdown,
      rebuttalsMarkdown: first.rebuttalsMarkdown,
      repliesMarkdown,
      // All three rounds merged, which is still what the web proxy renders.
      transcript: `${first.openingsMarkdown}\n${first.rebuttalsMarkdown}\n${repliesMarkdown}`,
    };
  },
});

const boardAnswerSchema = z.object({
  answer: z.string(),
  question: z.string(),
  threadId: z.string(),
  personas: z.array(personaTurnSchema),
  objections: z.array(objectionSchema),
  replies: z.array(replyTurnSchema),
  transcript: z.string(),
});

const titleSchema = z.object({
  title: z
    .string()
    .describe("Three to six words, no quotes, no trailing period."),
});

/**
 * Names a thread for the sidebar, after the question that opened it.
 *
 * Every failure is swallowed. By the time this runs the CEO's answer is
 * already written and stored, and an unnamed thread still lists under its first
 * question — so losing minutes of debate to a failed rename would be paying a
 * real price for a cosmetic one.
 */
async function titleThread(
  mastra: Mastra,
  threadId: string,
  question: string,
): Promise<void> {
  try {
    const agent = mastra.getAgentById("cfo-agent");

    const response = await agent.generate(
      `Title this board session in three to six words, as a neutral label a
busy CEO would recognise in a sidebar. No quotes, no trailing period, no
persona voice.

Question: "${question}"`,
      {
        // Naming is not reasoning, so it gets the cheap model. No `memory`
        // either: the thread should not carry its own naming prompt as a turn.
        model: "anthropic/claude-haiku-4-5",
        structuredOutput: { schema: titleSchema },
      },
    );

    const title = response.object?.title?.trim();
    if (!title) return;

    const memory = await agent.getMemory();
    const thread = await memory?.getThreadById({ threadId });

    // `metadata` is required by this signature even though it is optional on
    // the record, so the existing value has to be read and passed back rather
    // than defaulted — writing `{}` blind would erase it.
    await memory?.updateThread({
      id: threadId,
      title,
      metadata: thread?.metadata ?? {},
    });
  } catch {
    // See above: naming must never cost the CEO an answer.
  }
}

/**
 * The chair is the board's output: three rounds of argument become the one
 * answer the CEO reads. It is deliberately not wrapped in the `try/catch` the
 * persona steps use — a board with no answer has nothing to show, so a chair
 * that fails should fail the run rather than resolve to an empty recommendation.
 */
export const chairStep = createStep({
  id: "chair",
  inputSchema: debateStateSchema,
  outputSchema: boardAnswerSchema,
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

    // Saved here rather than after the debate so the record includes the answer
    // the CEO actually read; a session stored before the chair spoke would
    // reopen as an argument with no conclusion.
    await saveBoardSession({
      threadId: inputData.threadId,
      question: inputData.question,
      answer: response.text,
      personas: inputData.personas,
      objections: inputData.objections,
      replies: inputData.replies,
    });

    // First session only, counted after the save above so the thread that just
    // answered its opening question sees exactly one. A thread renamed by its
    // fifth question is one the CEO can no longer find in the sidebar.
    const sessions = await listBoardSessions(inputData.threadId);
    if (sessions.length === 1) {
      await titleThread(mastra, inputData.threadId, inputData.question);
    }

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

export const boardSessionWorkflow = createWorkflow({
  id: "boardSession",
  inputSchema: boardInputSchema,
  outputSchema: boardAnswerSchema,
})
  .map(async ({ inputData }) =>
    PERSONA_IDS.map((personaId) => ({
      personaId,
      question: inputData.question,
      threadId: inputData.threadId,
    })),
  )
  .foreach(openingStep, { concurrency: 4 })
  .then(renderOpeningsStep)
  .then(ceoPauseStep)
  // Fan out again, with everyone's openings attached.
  .map(async ({ inputData }) =>
    PERSONA_IDS.map((personaId) => ({
      personaId,
      question: inputData.question,
      threadId: inputData.threadId,
      openings: inputData.openings,
      openingsMarkdown: inputData.openingsMarkdown,
      personas: inputData.personas,
    })),
  )
  .foreach(rebuttalStep, { concurrency: 4 })
  // Fan out a third time, to the objected-to only.
  .map(async ({ inputData }) => toReplyInputs(inputData))
  .foreach(replyStep, { concurrency: 4 })
  .then(renderDebateStep)
  .then(chairStep)
  .commit();
