import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { PERSONA_IDS, type PersonaId } from "../agents/index.ts";
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

const openingEntrySchema = z.object({
  personaId: personaIdSchema,
  text: z.string(),
  question: z.string(),
  threadId: z.string(),
});

const rebuttalEntrySchema = z.object({
  personaId: personaIdSchema,
  disagrees: z.boolean(),
  with: z.array(personaIdSchema),
  statement: z.string(),
  // Carried through the second fan-out so the final step can prepend pass one.
  // `workflowRoute` does not forward writer output, so the transcript has to
  // survive as workflow output rather than as stream text.
  openingsMarkdown: z.string(),
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

    return { personaId, text: response.text, question, threadId };
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
  }),
  execute: async ({ inputData, writer }) => {
    const openings: OpeningEntry[] = inputData.map((entry) => ({
      personaId: entry.personaId,
      text: entry.text,
    }));

    // Stream the whole round at once so the sections cannot interleave.
    const openingsMarkdown = renderOpeningRound(openings);
    await writer?.write(openingsMarkdown);

    return {
      question: inputData[0].question,
      threadId: inputData[0].threadId,
      openings,
      openingsMarkdown,
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
  }),
  outputSchema: rebuttalEntrySchema,
  execute: async ({ inputData, mastra }) => {
    const { personaId, question, threadId, openings, openingsMarkdown } = inputData;
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

    const verdict = response.object ?? {
      disagrees: false,
      with: [],
      statement: "",
    };

    return { personaId, ...verdict, openingsMarkdown };
  },
});

const renderRebuttalsStep = createStep({
  id: "render-rebuttals",
  inputSchema: z.array(rebuttalEntrySchema),
  outputSchema: z.object({ transcript: z.string() }),
  execute: async ({ inputData, writer }) => {
    const markdown = renderRebuttalRound(inputData);
    await writer?.write(`\n${markdown}`);

    // Both rounds, in one string: the workflow's own output is the only place
    // the client can read the transcript from.
    return { transcript: `${inputData[0].openingsMarkdown}\n${markdown}` };
  },
});

export const boardSessionWorkflow = createWorkflow({
  id: "boardSession",
  inputSchema: boardInputSchema,
  outputSchema: z.object({ transcript: z.string() }),
})
  // Fan the question out to all four personas.
  .map(async ({ inputData }) =>
    PERSONA_IDS.map((personaId) => ({
      personaId,
      question: inputData.question,
      threadId: inputData.threadId,
    })),
  )
  .foreach(openingStep, { concurrency: 4 })
  .then(renderOpeningsStep)
  // Fan out again, this time with everyone's openings attached.
  .map(async ({ inputData }) =>
    PERSONA_IDS.map((personaId) => ({
      personaId,
      question: inputData.question,
      threadId: inputData.threadId,
      openings: inputData.openings,
      openingsMarkdown: inputData.openingsMarkdown,
    })),
  )
  .foreach(rebuttalStep, { concurrency: 4 })
  .then(renderRebuttalsStep)
  .commit();
