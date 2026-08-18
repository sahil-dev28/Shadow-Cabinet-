import { describe, expect, it } from "vitest";

import { runBoardSession } from "./board";
import type { BoardDebate } from "./debate";

/**
 * Mastra wraps every route in `timeout(server?.timeout ?? 180_000)`, so a board
 * session longer than three minutes cannot be awaited inside one request. These
 * tests pin the detached shape: start returns immediately, the run is polled.
 */
function fakeFetch(
  statuses: string[],
  answer = "Hold the spend.",
  /** `GET /runs/:runId` answers flat; the `/runs` list wraps rows in `snapshot`. */
  shape: "flat" | "wrapped" = "flat",
) {
  const calls: string[] = [];
  let poll = 0;

  const impl = async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(`${init?.method ?? "GET"} ${href.replace("http://board", "")}`);

    if (href.includes("/create-run")) {
      return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
    }

    if (href.includes("/start")) {
      // Must be the non-blocking start, never start-async.
      if (href.includes("start-async")) {
        throw new Error("start-async blocks past the server timeout");
      }
      return new Response("{}", { status: 200 });
    }

    const status = statuses[Math.min(poll++, statuses.length - 1)];
    const run = {
      status,
      result:
        status === "success"
          ? {
              answer,
              personas: [
                {
                  personaId: "cfo",
                  text: "Margin is down 4 points.",
                  evidence: [
                    {
                      toolCallId: "call-1",
                      toolName: "compareMetricTool",
                      input: { metric: "grossMarginPct" },
                      output: { ok: true, delta: -4 },
                    },
                  ],
                },
              ],
              objections: [
                {
                  personaId: "cmo",
                  disagrees: true,
                  with: ["cfo"],
                  statement: "Cutting spend forfeits pipeline.",
                },
              ],
              replies: [{ personaId: "cfo", text: "Payback is 14 months." }],
            }
          : undefined,
      error: status === "failed" ? "step blew up" : undefined,
    };

    return new Response(
      JSON.stringify(shape === "flat" ? run : { snapshot: run }),
      { status: 200 },
    );
  };

  return { impl, calls };
}

const OPENINGS = [
  { personaId: "cfo", text: "Margin is down.", evidence: [] },
  { personaId: "cmo", text: "Protect demand.", evidence: [] },
];

/**
 * What round two actually leaves in the run snapshot: the objection wrapped in
 * everything the third fan-out needs, because `foreach` hands the next step only
 * what its items return.
 */
const REBUTTAL_OUTPUT = [
  {
    personaId: "cmo",
    disagrees: true,
    with: ["cfo"],
    statement: "Pipeline dies.",
    openingsMarkdown: "### CFO\n...",
    personas: OPENINGS,
    question: "Should we cut spend?",
    threadId: "board-1",
  },
  {
    personaId: "coo",
    disagrees: false,
    with: [],
    statement: "",
    openingsMarkdown: "### CFO\n...",
    personas: OPENINGS,
    question: "Should we cut spend?",
    threadId: "board-1",
  },
];

const REPLY_OUTPUT = [
  {
    personaId: "cfo",
    text: "Payback is 14 months.",
    question: "Should we cut spend?",
    threadId: "board-1",
    personas: OPENINGS,
    objections: [],
    openingsMarkdown: "### CFO\n...",
    rebuttalsMarkdown: "### CMO\n...",
  },
  // The unopposed-board placeholder: state with nobody behind it.
  {
    personaId: null,
    text: "",
    question: "Should we cut spend?",
    threadId: "board-1",
    personas: OPENINGS,
    objections: [],
    openingsMarkdown: "### CFO\n...",
    rebuttalsMarkdown: "",
  },
];

/** A run that publishes one more round on each poll, as a real board does. */
function progressiveFetch() {
  let polls = 0;

  const impl = async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/create-run")) {
      return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
    }
    if (href.includes("/start")) return new Response("{}", { status: 200 });

    polls += 1;
    const steps: Record<string, unknown> = {};
    if (polls >= 2) {
      steps["render-openings"] = { status: "success", output: { personas: OPENINGS } };
    }
    if (polls >= 3) steps.rebuttal = { status: "success", output: REBUTTAL_OUTPUT };
    if (polls >= 4) steps.reply = { status: "success", output: REPLY_OUTPUT };

    return new Response(
      JSON.stringify({
        status: polls >= 5 ? "success" : "running",
        steps,
        result:
          polls >= 5
            ? {
                answer: "Hold the spend.",
                personas: OPENINGS,
                objections: [],
                replies: [{ personaId: "cfo", text: "Payback is 14 months." }],
              }
            : undefined,
      }),
      { status: 200 },
    );
  };

  return { impl };
}

describe("runBoardSession", () => {
  it("starts the run detached and polls until it succeeds", async () => {
    const { impl, calls } = fakeFetch(["running", "running", "success"]);

    const board = await runBoardSession({
      baseUrl: "http://board",
      question: "Why did margin fall?",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
    });

    if (board.status !== "complete") throw new Error("expected a completed board");
    expect(board.answer).toBe("Hold the spend.");
    // Each persona keeps its own grounding calls, which is what lets the UI
    // collapse one executive's evidence without folding in the others'.
    expect(board.debate.openings).toHaveLength(1);
    expect(board.debate.openings[0].evidence[0].toolName).toBe("compareMetricTool");
    expect(calls[0]).toBe("POST /api/workflows/boardSession/create-run");
    expect(calls[1]).toBe("POST /api/workflows/boardSession/start?runId=run-1");
    expect(calls.slice(2)).toEqual([
      "GET /api/workflows/boardSession/runs/run-1",
      "GET /api/workflows/boardSession/runs/run-1",
      "GET /api/workflows/boardSession/runs/run-1",
    ]);
  });

  it("still finishes when the run comes back wrapped in a snapshot", async () => {
    const { impl } = fakeFetch(["running", "success"], "Hold the spend.", "wrapped");

    await expect(
      runBoardSession({
        baseUrl: "http://board",
        question: "Why did margin fall?",
        threadId: "board-1",
        fetchImpl: impl,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ answer: "Hold the spend." });
  });

  it("returns the chair's answer and the three rounds", async () => {
    const { impl } = fakeFetch(["success"]);

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

  it("refuses a finished run that carries no answer", async () => {
    const impl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/create-run")) {
        return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
      }
      if (href.includes("/start")) return new Response("{}", { status: 200 });

      // Three rounds and no recommendation is not a board the CEO can act on.
      return new Response(
        JSON.stringify({ status: "success", result: { personas: [], objections: [], replies: [] } }),
        { status: 200 },
      );
    };

    await expect(
      runBoardSession({
        baseUrl: "http://board",
        question: "Should we cut spend?",
        threadId: "board-1",
        fetchImpl: impl,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/no answer/);
  });

  it("gives up instead of polling forever when the status field is missing", async () => {
    const impl = async (url: string | URL) =>
      String(url).includes("/create-run")
        ? new Response(JSON.stringify({ runId: "run-1" }), { status: 200 })
        : new Response("{}", { status: 200 });

    await expect(
      runBoardSession({
        baseUrl: "http://board",
        question: "Why did margin fall?",
        threadId: "board-1",
        fetchImpl: impl,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/status is missing/);
  });

  it("hands over the opening round before the run finishes", async () => {
    const openings = [
      { personaId: "cfo", text: "Margin is down.", evidence: [] },
      { personaId: "cmo", text: "Protect demand.", evidence: [] },
    ];
    let polls = 0;

    const impl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/create-run")) {
        return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
      }
      if (href.includes("/start")) return new Response("{}", { status: 200 });

      polls += 1;
      // Round one lands on the second poll; the run finishes on the third.
      return new Response(
        JSON.stringify({
          status: polls >= 3 ? "success" : "running",
          steps:
            polls >= 2
              ? { "render-openings": { status: "success", output: { personas: openings } } }
              : {},
          result:
            polls >= 3
              ? { answer: "Hold the spend.", personas: openings, objections: [], replies: [] }
              : undefined,
        }),
        { status: 200 },
      );
    };

    const seen: BoardDebate[] = [];
    await runBoardSession({
      baseUrl: "http://board",
      question: "Why did margin fall?",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      onProgress: (debate) => seen.push(debate),
    });

    // Once, on the poll that first exposes it — not again when the run ends.
    expect(seen).toHaveLength(1);
    expect(seen[0].openings.map((p) => p.personaId)).toEqual(["cfo", "cmo"]);
    // Openings without objections is the round-one beat, whatever else the run
    // does afterwards, so the UI can draw round two as still in flight.
    expect(seen[0].phase).toBe("openings");
  });

  it("reports each round once, as the run publishes it", async () => {
    const { impl } = progressiveFetch();

    const seen: BoardDebate[] = [];
    const board = await runBoardSession({
      baseUrl: "http://board",
      question: "Should we cut spend?",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      onProgress: (debate) => seen.push(debate),
    });

    // Three beats, not eight: `foreach` publishes a round as a whole array, so
    // an executive finishing before its peers is not observable.
    expect(seen.map((debate) => debate.phase)).toEqual([
      "openings",
      "objections",
      "replies",
    ]);

    // Each call carries everything known so far, so the section only ever grows.
    expect(seen[0]).toMatchObject({ openings: OPENINGS, objections: [], replies: [] });
    expect(seen[1].openings).toEqual(OPENINGS);
    expect(seen[2].openings).toEqual(OPENINGS);
    expect(seen[1].replies).toEqual([]);

    expect(board.status).toBe("complete");
  });

  it("strips the plumbing round two and three carry between steps", async () => {
    const { impl } = progressiveFetch();

    const seen: BoardDebate[] = [];
    await runBoardSession({
      baseUrl: "http://board",
      question: "Should we cut spend?",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      onProgress: (debate) => seen.push(debate),
    });

    // The step output also carries the openings, the transcript and the thread
    // id so the next fan-out has them; none of that belongs on screen.
    expect(seen[1].objections).toEqual([
      { personaId: "cmo", disagrees: true, with: ["cfo"], statement: "Pipeline dies." },
      { personaId: "coo", disagrees: false, with: [], statement: "" },
    ]);

    // The persona-less item an unopposed board fans through round three is
    // plumbing, so it must never render as an executive with nothing to say.
    expect(seen[2].replies).toEqual([{ personaId: "cfo", text: "Payback is 14 months." }]);
  });

  it("stops reporting the board as working once it halts on a question", async () => {
    let polls = 0;
    const impl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/create-run")) {
        return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
      }
      if (href.includes("/start")) return new Response("{}", { status: 200 });

      polls += 1;
      return new Response(
        JSON.stringify({
          status: polls >= 2 ? "suspended" : "running",
          steps: {
            "render-openings": { status: "success", output: { personas: OPENINGS } },
            "ceo-question":
              polls >= 2
                ? {
                    status: "suspended",
                    suspendPayload: {
                      questions: [{ personaId: "cfo", question: "What is the budget?" }],
                    },
                  }
                : { status: "running" },
          },
        }),
        { status: 200 },
      );
    };

    const seen: BoardDebate[] = [];
    const board = await runBoardSession({
      baseUrl: "http://board",
      question: "Should we cut spend?",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      onProgress: (debate) => seen.push(debate),
    });

    expect(board.status).toBe("waiting");
    // The openings stand, but nothing is running, so the last word on the
    // debate must not leave round two shimmering forever.
    expect(seen.map((debate) => debate.phase)).toEqual(["openings", "paused"]);
    expect(seen[1].openings).toEqual(OPENINGS);
  });

  it("reports the debate afresh when a resumed board carries on", async () => {
    let polls = 0;
    const impl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/resume")) return new Response("{}", { status: 200 });

      polls += 1;
      return new Response(
        JSON.stringify({
          status: polls >= 2 ? "running" : "suspended",
          steps: {
            "render-openings": { status: "success", output: { personas: OPENINGS } },
            ...(polls >= 3 ? { rebuttal: { output: REBUTTAL_OUTPUT } } : {}),
            ...(polls >= 4 ? { reply: { output: REPLY_OUTPUT } } : {}),
          },
          ...(polls >= 5
            ? {
                status: "success",
                result: {
                  answer: "Hold the spend.",
                  personas: OPENINGS,
                  objections: [],
                  replies: [],
                },
              }
            : {}),
        }),
        { status: 200 },
      );
    };

    const seen: BoardDebate[] = [];
    await runBoardSession({
      baseUrl: "http://board",
      question: "Budget is 2 million.",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      resumeRunId: "run-9",
      onProgress: (debate) => seen.push(debate),
    });

    // Every beat again, not just the ones the answer unblocked: the board's
    // stream reuses one message id, so the reply replaces the message the
    // openings were in and they have to be re-sent to stay on screen.
    expect(seen.map((debate) => debate.phase)).toEqual([
      "openings",
      "objections",
      "replies",
    ]);
  });

  it("reports a halted board with the questions it is waiting on", async () => {
    const impl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/create-run")) {
        return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
      }
      if (href.includes("/start")) return new Response("{}", { status: 200 });

      return new Response(
        JSON.stringify({
          status: "suspended",
          steps: {
            "ceo-question": {
              status: "suspended",
              suspendPayload: {
                questions: [{ personaId: "cfo", question: "What is the budget?" }],
              },
            },
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

    expect(board).toEqual({
      status: "waiting",
      questions: [{ personaId: "cfo", question: "What is the budget?" }],
    });
  });

  it("resumes a halted board instead of starting a new one", async () => {
    const calls: string[] = [];
    const impl = async (url: string | URL, init?: RequestInit) => {
      const href = String(url).replace("http://board", "");
      calls.push(`${init?.method ?? "GET"} ${href}`);

      if (href.includes("/resume")) return new Response("{}", { status: 200 });

      return new Response(
        JSON.stringify({
          status: "success",
          result: { answer: "Hold the spend.", personas: [], objections: [], replies: [] },
        }),
        { status: 200 },
      );
    };

    await runBoardSession({
      baseUrl: "http://board",
      question: "Budget is 2 million.",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      resumeRunId: "run-9",
    });

    expect(calls[0]).toBe("POST /api/workflows/boardSession/resume?runId=run-9");
    expect(calls.some((c) => c.includes("create-run"))).toBe(false);
  });

  it("does not re-report waiting while a resumed run is still picking up", async () => {
    let polls = 0;
    const impl = async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/resume")) return new Response("{}", { status: 200 });

      polls += 1;
      // Resume is asynchronous: the run reads as suspended for a moment.
      return new Response(
        JSON.stringify(
          polls < 3
            ? {
                status: "suspended",
                steps: {
                  "ceo-question": {
                    suspendPayload: { questions: [{ personaId: "cfo", question: "?" }] },
                  },
                },
              }
            : {
                status: "success",
                result: { answer: "Hold the spend.", personas: [], objections: [], replies: [] },
              },
        ),
        { status: 200 },
      );
    };

    const board = await runBoardSession({
      baseUrl: "http://board",
      question: "Budget is 2 million.",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      resumeRunId: "run-9",
    });

    expect(board.status).toBe("complete");
  });

  it("reports a failed run instead of hanging", async () => {
    const { impl } = fakeFetch(["running", "failed"]);

    await expect(
      runBoardSession({
        baseUrl: "http://board",
        question: "Why did margin fall?",
        threadId: "board-1",
        fetchImpl: impl,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/step blew up/);
  });
});
