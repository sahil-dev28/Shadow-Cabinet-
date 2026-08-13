import { describe, expect, it } from "vitest";

import { runBoardSession } from "./board";

/**
 * Mastra wraps every route in `timeout(server?.timeout ?? 180_000)`, so a board
 * session longer than three minutes cannot be awaited inside one request. These
 * tests pin the detached shape: start returns immediately, the run is polled.
 */
function fakeFetch(
  statuses: string[],
  transcript = "## Opening statements\n",
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
              transcript,
              rebuttalsMarkdown: "## Where the board disagrees\n",
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
    expect(board.transcript).toBe("## Opening statements\n");
    // Each persona keeps its own grounding calls, which is what lets the UI
    // collapse one executive's evidence without folding in the others'.
    expect(board.personas).toHaveLength(1);
    expect(board.personas[0].evidence[0].toolName).toBe("compareMetricTool");
    expect(calls[0]).toBe("POST /api/workflows/boardSession/create-run");
    expect(calls[1]).toBe("POST /api/workflows/boardSession/start?runId=run-1");
    expect(calls.slice(2)).toEqual([
      "GET /api/workflows/boardSession/runs/run-1",
      "GET /api/workflows/boardSession/runs/run-1",
      "GET /api/workflows/boardSession/runs/run-1",
    ]);
  });

  it("still finishes when the run comes back wrapped in a snapshot", async () => {
    const { impl } = fakeFetch(["running", "success"], "## Opening statements\n", "wrapped");

    await expect(
      runBoardSession({
        baseUrl: "http://board",
        question: "Why did margin fall?",
        threadId: "board-1",
        fetchImpl: impl,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ transcript: "## Opening statements\n" });
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
              ? { transcript: "t", personas: openings, rebuttalsMarkdown: "r" }
              : undefined,
        }),
        { status: 200 },
      );
    };

    const seen: string[][] = [];
    await runBoardSession({
      baseUrl: "http://board",
      question: "Why did margin fall?",
      threadId: "board-1",
      fetchImpl: impl,
      pollIntervalMs: 0,
      onRoundOne: (personas) => seen.push(personas.map((p) => p.personaId)),
    });

    // Once, on the poll that first exposes it — not again when the run ends.
    expect(seen).toEqual([["cfo", "cmo"]]);
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
          result: { transcript: "t", personas: [], rebuttalsMarkdown: "r" },
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
                result: { transcript: "t", personas: [], rebuttalsMarkdown: "r" },
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
