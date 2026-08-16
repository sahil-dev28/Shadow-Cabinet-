import { describe, expect, it, vi } from "vitest";

// The chair step persists the session; left real it would open Mongo or write
// a JSON file into the source tree on every run.
vi.mock("../data/board-sessions.ts", () => ({
  saveBoardSession: vi.fn(async () => undefined),
  // Counted by the chair to decide whether this thread still needs a name.
  listBoardSessions: vi.fn(async () => []),
}));

import { listBoardSessions, saveBoardSession } from "../data/board-sessions.ts";
import {
  ceoPauseStep,
  chairStep,
  openingStep,
  rebuttalStep,
  renderDebateStep,
  replyStep,
  toReplyInputs,
} from "./board-session.ts";

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

  it("falls back to the prose when structured output returns an empty position", async () => {
    const generate = vi.fn(async () => ({
      text: "Margin fell 4 points, driven by mix.",
      object: { position: "   ", questionForCeo: "" },
    }));

    const result = await callStep<{ text: string }>(openingStep, {
      inputData: { personaId: "cfo", question: "Why did margin fall?", threadId: "t1" },
      mastra: fakeMastra(generate as Generate),
    });

    // An executive with evidence and no opinion is worse than one that repeats
    // itself: this happened live on thread t6-parts.
    expect(result.text).toBe("Margin fell 4 points, driven by mix.");
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

describe("round three", () => {
  type RoundTwo = Parameters<typeof toReplyInputs>[0];

  const carried = {
    openingsMarkdown: "## Opening statements\n",
    personas: [{ personaId: "cfo" as const, text: "Cut spend.", evidence: [] }],
    question: "Should we cut spend?",
    threadId: "t1",
  };

  const contested: RoundTwo = [
    { personaId: "cfo", disagrees: false, with: [], statement: "", ...carried },
    {
      personaId: "cmo",
      disagrees: true,
      with: ["cfo"],
      statement: "Pipeline dies without spend.",
      ...carried,
    },
    {
      personaId: "coo",
      disagrees: true,
      with: ["cso"],
      statement: "Neither plan can be staffed.",
      ...carried,
    },
    { personaId: "cso", disagrees: false, with: [], statement: "", ...carried },
  ];

  const unanimous: RoundTwo = contested.map((entry) => ({
    ...entry,
    disagrees: false,
    with: [],
    statement: "",
  }));

  it("calls only the personas an objection named", () => {
    expect(toReplyInputs(contested).map((input) => input.personaId)).toEqual([
      "cfo",
      "cso",
    ]);
  });

  it("shows a persona only the objections aimed at it", async () => {
    const generate = vi.fn(async () => ({ text: "Payback is 14 months." }));

    const result = await callStep<{ personaId: string; text: string }>(replyStep, {
      inputData: toReplyInputs(contested)[0],
      mastra: fakeMastra(generate as Generate),
    });

    expect(result.personaId).toBe("cfo");
    expect(result.text).toBe("Payback is 14 months.");

    // Answering an objection aimed at someone else is the fourth round this
    // board does not have.
    const [prompt] = generate.mock.calls[0] as unknown as [string];
    expect(prompt).toContain("Pipeline dies without spend.");
    expect(prompt).not.toContain("Neither plan can be staffed.");
  });

  it("reports an executive that threw instead of failing the round", async () => {
    const generate = vi.fn(async () => {
      throw new Error("model overloaded");
    });

    const result = await callStep<{ text: string }>(replyStep, {
      inputData: toReplyInputs(contested)[0],
      mastra: fakeMastra(generate as Generate),
    });

    expect(result.text).toMatch(/CFO is unavailable for this round/);
  });

  it("renders all three rounds once the replies are in", async () => {
    const generate = vi.fn(async () => ({ text: "Payback is 14 months." }));

    const entries = await Promise.all(
      toReplyInputs(contested).map((inputData) =>
        callStep(replyStep, { inputData, mastra: fakeMastra(generate as Generate) }),
      ),
    );

    const debate = await callStep<{
      replies: Array<{ personaId: string }>;
      objections: Array<Record<string, unknown>>;
      repliesMarkdown: string;
      personas: unknown[];
    }>(renderDebateStep, { inputData: entries });

    expect(debate.replies.map((reply) => reply.personaId)).toEqual(["cfo", "cso"]);
    expect(debate.repliesMarkdown).toContain("**CFO replies**");
    expect(debate.personas).toEqual(carried.personas);
    // Round one's state is not copied onto every objection four times over.
    expect(Object.keys(debate.objections[0]).sort()).toEqual([
      "disagrees",
      "personaId",
      "statement",
      "with",
    ]);
  });

  it("still renders the debate when nobody was objected to", async () => {
    const generate = vi.fn(async () => ({ text: "never asked" }));

    // The empty fan-out is the normal unopposed-board path, and `foreach` over
    // an empty array would leave the render step with nothing to render.
    const inputs = toReplyInputs(unanimous);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].personaId).toBeNull();

    const entries = await Promise.all(
      inputs.map((inputData) =>
        callStep(replyStep, { inputData, mastra: fakeMastra(generate as Generate) }),
      ),
    );

    expect(generate).not.toHaveBeenCalled();

    const debate = await callStep<{
      question: string;
      threadId: string;
      replies: unknown[];
      repliesMarkdown: string;
      personas: unknown[];
    }>(renderDebateStep, { inputData: entries });

    expect(debate.replies).toEqual([]);
    expect(debate.repliesMarkdown).toContain("No replies were needed");
    // Rounds one and two survive the round that never ran.
    expect(debate.question).toBe("Should we cut spend?");
    expect(debate.threadId).toBe("t1");
    expect(debate.personas).toEqual(carried.personas);
  });
});

describe("the chair", () => {
  const debate = {
    question: "Should we cut spend?",
    threadId: "t1",
    personas: [{ personaId: "cfo", text: "Cut spend.", evidence: [] }],
    objections: [
      { personaId: "cmo", disagrees: true, with: ["cfo"], statement: "Pipeline." },
    ],
    replies: [{ personaId: "cfo", text: "Payback is 14 months." }],
    openingsMarkdown: "## Opening statements\n",
    rebuttalsMarkdown: "## Where the board disagrees\n",
    repliesMarkdown: "## Replies\n",
    transcript: "the whole debate",
  };

  it("stores the session only once the answer exists", async () => {
    const save = vi.mocked(saveBoardSession);
    save.mockClear();

    const generate = vi.fn(async () => ({ text: "Hold the spend." }));

    const result = await callStep<{ answer: string }>(chairStep, {
      inputData: debate,
      mastra: fakeMastra(generate as Generate),
    });

    expect(result.answer).toBe("Hold the spend.");

    // A session written by the earlier render step would have reopened as an
    // argument with no conclusion.
    expect(save).toHaveBeenCalledTimes(1);
    const [stored] = save.mock.calls[0];
    expect(stored.answer).toBe("Hold the spend.");
    expect(stored.question).toBe("Should we cut spend?");

    // The rounds are stored as the CEO reads them, not with the round-one state
    // the fan-outs carried to get here.
    expect(Object.keys(stored.objections[0]).sort()).toEqual([
      "disagrees",
      "personaId",
      "statement",
      "with",
    ]);
    expect(Object.keys(stored.replies[0]).sort()).toEqual(["personaId", "text"]);
  });

  it("names the thread on its first session and never again", async () => {
    const list = vi.mocked(listBoardSessions);
    const updateThread = vi.fn(async () => undefined);
    const generate = vi.fn(async () => ({
      text: "Hold the spend.",
      object: { title: "Marketing spend and margin" },
    }));
    const memory = {
      getThreadById: async () => ({ metadata: { pinned: true } }),
      updateThread,
    };
    const mastra = () =>
      fakeMastra(generate as Generate, { getMemory: async () => memory });

    // One stored session: the save just above it wrote this thread's first.
    list.mockResolvedValueOnce([{}] as never);
    await callStep(chairStep, { inputData: debate, mastra: mastra() });

    expect(updateThread).toHaveBeenCalledWith({
      id: "t1",
      title: "Marketing spend and margin",
      // Read back and passed through: the signature requires metadata, so
      // defaulting it to `{}` here would erase whatever the thread carried.
      metadata: { pinned: true },
    });

    // A second question on the same thread must not rename it under the CEO.
    updateThread.mockClear();
    list.mockResolvedValueOnce([{}, {}] as never);
    await callStep(chairStep, { inputData: debate, mastra: mastra() });

    expect(updateThread).not.toHaveBeenCalled();
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
