import { describe, expect, it, vi } from "vitest";

import { ceoPauseStep, openingStep, rebuttalStep } from "./board-session.ts";

/**
 * These call the steps directly rather than running the workflow: a board
 * session is nine live agent calls and minutes of wall clock, which is not a
 * test. What is worth pinning is the orchestration around those calls — what
 * the round hands to the next one, and what happens when an executive fails.
 */

type Generate = (...args: unknown[]) => Promise<unknown>;

/** Enough of a Mastra instance for a step to look an agent up and call it. */
function fakeMastra(generate: Generate, extra: Record<string, unknown> = {}) {
  return {
    getAgentById: () => ({ generate, getMemory: async () => null, ...extra }),
  } as never;
}

const runtime: Record<string, unknown> = {
  runId: "run-1",
  suspend: async () => undefined,
  resumeData: undefined,
};

function callStep<T>(step: { execute: unknown }, args: Record<string, unknown>) {
  const execute = step.execute as (input: unknown) => Promise<T>;
  return execute({ ...runtime, ...args });
}

describe("round one", () => {
  it("hands the next round a position and the evidence behind it", async () => {
    const generate = vi.fn(async () => ({
      text: "Margin fell 4 points.",
      toolCalls: [
        {
          payload: {
            toolCallId: "call-1",
            toolName: "compareMetricTool",
            args: { metric: "grossMarginPct" },
          },
        },
      ],
      toolResults: [
        { payload: { toolCallId: "call-1", result: { ok: true, delta: -4 } } },
      ],
    }));

    const result = await callStep<{
      personaId: string;
      text: string;
      evidence: Array<{ toolName: string; output: unknown }>;
    }>(openingStep, {
      inputData: { personaId: "cfo", question: "Why did margin fall?", threadId: "t1" },
      mastra: fakeMastra(generate as Generate),
    });

    expect(result.personaId).toBe("cfo");
    expect(result.text).toBe("Margin fell 4 points.");
    // The call and its result are paired back together for the UI.
    expect(result.evidence).toEqual([
      {
        toolCallId: "call-1",
        toolName: "compareMetricTool",
        input: { metric: "grossMarginPct" },
        output: { ok: true, delta: -4 },
      },
    ]);
  });

  it("reports an executive that threw instead of failing the whole round", async () => {
    const generate = vi.fn(async () => {
      throw new Error("upstream timed out");
    });

    const result = await callStep<{ text: string; evidence: unknown[] }>(openingStep, {
      inputData: { personaId: "cmo", question: "Why did margin fall?", threadId: "t1" },
      mastra: fakeMastra(generate as Generate),
    });

    // Named, absent, and with the reason — the same shape a guardrail block
    // produces, so the other three executives still make a board.
    expect(result.text).toMatch(/CMO is unavailable for this round/);
    expect(result.text).toMatch(/upstream timed out/);
    expect(result.evidence).toEqual([]);
  });
});

describe("round two", () => {
  it("carries round one forward so the debate can be rendered", async () => {
    const generate = vi.fn(async () => ({
      object: { disagrees: true, with: ["cfo"], statement: "Payback is 14 months." },
    }));

    const personas = [{ personaId: "cfo", text: "Cut spend.", evidence: [] }];

    const result = await callStep<{
      disagrees: boolean;
      with: string[];
      personas: unknown[];
      openingsMarkdown: string;
    }>(rebuttalStep, {
      inputData: {
        personaId: "cmo",
        question: "Should we cut spend?",
        threadId: "t1",
        openings: [{ personaId: "cfo", text: "Cut spend." }],
        openingsMarkdown: "## Opening statements\n",
        personas,
        contested: true,
      },
      mastra: fakeMastra(generate as Generate),
    });

    expect(result.disagrees).toBe(true);
    expect(result.with).toEqual(["cfo"]);
    // Round one has to survive the second fan-out; the workflow output is the
    // only place the client can read it from.
    expect(result.personas).toEqual(personas);
    expect(result.openingsMarkdown).toBe("## Opening statements\n");
  });

  it("surfaces an executive that threw as a visible absence, not silent agreement", async () => {
    const generate = vi.fn(async () => {
      throw new Error("model overloaded");
    });

    const result = await callStep<{ disagrees: boolean; statement: string }>(
      rebuttalStep,
      {
        inputData: {
          personaId: "coo",
          question: "Should we cut spend?",
          threadId: "t1",
          openings: [{ personaId: "cfo", text: "Cut spend." }],
          openingsMarkdown: "## Opening statements\n",
          personas: [],
          contested: true,
        },
        mastra: fakeMastra(generate as Generate),
      },
    );

    // disagrees:true is deliberate — a failure counted as "no objection" would
    // quietly make the board look more unanimous than it was.
    expect(result.disagrees).toBe(true);
    expect(result.statement).toMatch(/COO is unavailable for this round/);
  });
});

describe("the CEO interrupt", () => {
  const state = {
    question: "Should we sell the unit?",
    threadId: "t1",
    openings: [{ personaId: "cfo", text: "Depends on the price." }],
    openingsMarkdown: "## Opening statements\n",
    personas: [{ personaId: "cfo", text: "Depends on the price.", evidence: [] }],
    ceoQuestions: [{ personaId: "cfo", question: "What is the offer?" }],
  };

  it("passes straight through when nobody asked anything", async () => {
    const generate = vi.fn(async () => ({ text: "" }));

    const result = await callStep<typeof state>(ceoPauseStep, {
      inputData: { ...state, ceoQuestions: [] },
      mastra: fakeMastra(generate as Generate),
    });

    expect(result).toEqual({ ...state, ceoQuestions: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps the existing openings on resume instead of re-running round one", async () => {
    const generate = vi.fn(async () => ({ text: "a fresh position" }));
    const saveMessages = vi.fn(async () => undefined);

    const result = await callStep<typeof state>(ceoPauseStep, {
      inputData: state,
      resumeData: { answer: "They offered 95 million." },
      mastra: fakeMastra(generate as Generate, {
        getMemory: async () => ({ saveMessages }),
      }),
    });

    // The whole point of resuming rather than restarting: the CEO keeps reading
    // the answers already on screen.
    expect(result.personas).toEqual(state.personas);
    expect(result.openings).toEqual(state.openings);
    expect(result.ceoQuestions).toEqual([]);
    expect(generate).not.toHaveBeenCalled();

    // The answer lands in the thread every persona shares.
    const [{ messages }] = saveMessages.mock.calls[0] as unknown as [
      { messages: Array<{ threadId: string; content: { parts: Array<{ text: string }> } }> },
    ];
    expect(messages[0].threadId).toBe("t1");
    expect(messages[0].content.parts[0].text).toContain("They offered 95 million.");
  });
});
