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

      return {
        personaId,
        text: blocked ?? opening.position,
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
  .then(renderRebuttalsStep)
  .commit();
