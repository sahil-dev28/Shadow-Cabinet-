import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { PERSONA_IDS, type PersonaId } from "../agents/index.ts";
import { saveBoardSession } from "../data/board-sessions.ts";
import { clearPendingRun, savePendingRun } from "../data/pending-runs.ts";
import {
  type OpeningEntry,
  formatOpeningsForRebuttal,
  renderOpeningRound,
  renderRebuttalRound,
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

const rebuttalEntrySchema = z.object({
  personaId: personaIdSchema,
  disagrees: z.boolean(),
  with: z.array(personaIdSchema),
  statement: z.string(),
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
 * Read off the openings by a cheap model rather than asked of each executive:
 * it costs one call instead of four, and it keeps the openings themselves free
 * of structured-output scaffolding.
 */
const triageSchema = z.object({
  contested: z
    .boolean()
    .describe(
      "True only if two executives reach genuinely different conclusions about what to do. Different emphasis on the same conclusion is not contested.",
    ),
  ceoQuestions: z
    .array(ceoQuestionSchema)
    .describe(
      "Blocking questions only. Include one only if an executive cannot stand behind its recommendation until the CEO answers, and only the CEO can answer it. Rhetorical framing, requests for data the company would hold, and 'it depends on X' asides are NOT blocking. Most rounds have none. Never more than one per executive.",
    ),
});

/** Pausing the board is expensive, so it takes more than one executive asking. */
const CEO_PAUSE_THRESHOLD = 2;

/** Pass one: one persona answers the CEO without seeing its peers. */
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
    });

    const blocked = tripwireNotice(personaId, response);

    return {
      personaId,
      text: blocked ?? response.text,
      evidence: blocked ? [] : collectEvidence(response),
      question,
      threadId,
    };
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

    // Stream the whole round at once so the sections cannot interleave.
    const openingsMarkdown = renderOpeningRound(openings);
    await writer?.write(openingsMarkdown);

    return {
      question: inputData[0].question,
      threadId: inputData[0].threadId,
      openings,
      openingsMarkdown,
      personas,
    };
  },
});

const roundOneStateSchema = z.object({
  question: z.string(),
  threadId: z.string(),
  openings: z.array(z.object({ personaId: personaIdSchema, text: z.string() })),
  openingsMarkdown: z.string(),
  personas: z.array(personaTurnSchema),
  contested: z.boolean(),
  ceoQuestions: z.array(ceoQuestionSchema),
});

/**
 * Reads the openings and decides two things: whether round two is warranted at
 * all, and whether anyone put a question to the CEO. A unanimous board with no
 * questions stops here, which is the difference between five agent calls and
 * nine.
 */
const triageStep = createStep({
  id: "triage",
  inputSchema: roundOneStateSchema.omit({ contested: true, ceoQuestions: true }),
  outputSchema: roundOneStateSchema,
  execute: async ({ inputData, mastra }) => {
    const agent = mastra.getAgentById("cfo-agent");

    const response = await agent.generate(
      `You are triaging a board meeting transcript. Do not take a position.

${inputData.openingsMarkdown}

Report whether the executives genuinely disagree about what to do, and list only
questions that block an executive from standing behind its recommendation until
the CEO personally answers. An executive listing what it would like to see next
is not blocked. Most rounds have no blocking question at all.`,
      {
        model: "anthropic/claude-haiku-4-5",
        structuredOutput: { schema: triageSchema },
      },
    );

    const triage = response.object ?? { contested: true, ceoQuestions: [] };

    // One question per executive, and only pause when enough of the board is
    // actually stuck — a single asker is not worth halting the session for.
    const firstPerPersona = [
      ...new Map(
        triage.ceoQuestions.map((entry) => [entry.personaId, entry]),
      ).values(),
    ];

    return {
      ...inputData,
      contested: triage.contested,
      ceoQuestions:
        firstPerPersona.length >= CEO_PAUSE_THRESHOLD ? firstPerPersona : [],
    };
  },
});

/**
 * Halts the board when an executive needs something only the CEO can supply.
 * Questions are batched into one pause rather than asked one at a time, and the
 * answer is written back into the shared thread so every persona sees it.
 */
const ceoPauseStep = createStep({
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

    // Only the executives that asked revise; the rest keep their positions.
    const asked = new Set(inputData.ceoQuestions.map((entry) => entry.personaId));

    const personas = await Promise.all(
      inputData.personas.map(async (persona) => {
        if (!asked.has(persona.personaId as PersonaId)) return persona;

        const agent = mastra.getAgentById(`${persona.personaId}-agent`);
        const response = await agent.generate(
          `The CEO answered your question: "${resumeData.answer}"

Give your position again, now that you have that answer.`,
          { memory: { resource: "ceo", thread: inputData.threadId } },
        );

        const blocked = tripwireNotice(persona.personaId as PersonaId, response);

        return {
          personaId: persona.personaId,
          text: blocked ?? response.text,
          evidence: blocked ? [] : collectEvidence(response),
        };
      }),
    );

    const openings = personas.map(({ personaId, text }) => ({ personaId, text }));

    return {
      ...inputData,
      personas,
      openings,
      openingsMarkdown: renderOpeningRound(openings as OpeningEntry[]),
      ceoQuestions: [],
    };
  },
});

/** Pass two: this persona reads the others and says whether it objects. */
const rebuttalStep = createStep({
  id: "rebuttal",
  inputSchema: z.object({
    personaId: personaIdSchema,
    question: z.string(),
    threadId: z.string(),
    openings: z.array(z.object({ personaId: personaIdSchema, text: z.string() })),
    openingsMarkdown: z.string(),
    personas: z.array(personaTurnSchema),
    contested: z.boolean(),
  }),
  outputSchema: rebuttalEntrySchema,
  execute: async ({ inputData, mastra }) => {
    const { personaId, question, threadId, openings, openingsMarkdown, personas } =
      inputData;

    // Round two is for resolving disagreement. Where triage found none, asking
    // four executives to object anyway invites manufactured dissent.
    if (!inputData.contested) {
      return {
        personaId,
        disagrees: false,
        with: [],
        statement: "",
        openingsMarkdown,
        personas,
        question,
        threadId,
      };
    }

    const agent = mastra.getAgentById(`${personaId}-agent`);

    const others = formatOpeningsForRebuttal(openings, personaId);

    const response = await agent.generate(
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

    // A blocked rebuttal is surfaced as a disagreement entry so the reader sees
    // the persona was silenced, not that it declined to object.
    const blocked = tripwireNotice(personaId, response);
    const verdict = blocked
      ? { disagrees: true, with: [] as PersonaId[], statement: blocked }
      : (response.object ?? { disagrees: false, with: [], statement: "" });

    return { personaId, ...verdict, openingsMarkdown, personas, question, threadId };
  },
});

const renderRebuttalsStep = createStep({
  id: "render-rebuttals",
  inputSchema: z.array(rebuttalEntrySchema),
  outputSchema: z.object({
    transcript: z.string(),
    personas: z.array(personaTurnSchema),
    rebuttalsMarkdown: z.string(),
  }),
  execute: async ({ inputData, writer }) => {
    const markdown = renderRebuttalRound(inputData);
    await writer?.write(`\n${markdown}`);

    // Persisted as the CEO saw it, so reopening the thread replays the board
    // rather than the agents' internal prompts.
    await saveBoardSession({
      threadId: inputData[0].threadId,
      question: inputData[0].question,
      personas: inputData[0].personas,
      rebuttalsMarkdown: markdown,
    });

    // `transcript` is both rounds merged; `personas` is the same openings split
    // per agent so the UI can render each executive with its own evidence.
    return {
      transcript: `${inputData[0].openingsMarkdown}\n${markdown}`,
      personas: inputData[0].personas,
      rebuttalsMarkdown: markdown,
    };
  },
});

export const boardSessionWorkflow = createWorkflow({
  id: "boardSession",
  inputSchema: boardInputSchema,
  outputSchema: z.object({
    transcript: z.string(),
    personas: z.array(personaTurnSchema),
    rebuttalsMarkdown: z.string(),
  }),
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
  .then(triageStep)
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
      contested: inputData.contested,
    })),
  )
  .foreach(rebuttalStep, { concurrency: 4 })
  .then(renderRebuttalsStep)
  .commit();
