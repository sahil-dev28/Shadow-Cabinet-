import type {
  BoardDebate,
  BoardObjection,
  BoardPersonaTurn,
  BoardReply,
  CeoQuestion,
} from "./debate";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface RunBoardSessionOptions {
  baseUrl: string;
  question: string;
  threadId: string;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  pollIntervalMs?: number;
  /**
   * Fires as soon as the opening round is readable, roughly a third of the way
   * into a session, so the CEO reads four positions while the board is still
   * arguing instead of watching a spinner for the whole run.
   */
  onRoundOne?: (personas: BoardPersonaTurn[]) => void;
  /** Set when the board is halted on a CEO question and this is the answer. */
  resumeRunId?: string;
}

/**
 * A board either finishes with the chair's answer, or halts waiting on the CEO.
 *
 * The answer and the debate are separate because they are rendered separately:
 * the answer is the message the CEO reads, the debate is the argument folded
 * underneath it.
 */
export type BoardOutcome =
  | { status: "complete"; answer: string; debate: BoardDebate }
  | { status: "waiting"; questions: CeoQuestion[] };

interface RunSnapshot {
  status?: string;
  result?: {
    answer?: string;
    personas?: BoardPersonaTurn[];
    objections?: BoardObjection[];
    replies?: BoardReply[];
  };
  error?: unknown;
  steps?: Record<
    string,
    {
      status?: string;
      output?: { personas?: BoardPersonaTurn[] };
      suspendPayload?: { questions?: CeoQuestion[] };
    }
  >;
}

/**
 * `GET /runs/:runId` returns the run flat; the `/runs` list wraps rows in
 * `snapshot`. Accept either, or an undefined status hangs the poll loop.
 */
function readSnapshot(body: RunSnapshot & { snapshot?: RunSnapshot }): RunSnapshot {
  return body.snapshot?.status ? body.snapshot : body;
}

async function asJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Board ${what} returned ${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

/**
 * Runs one board session and returns the chair's answer with the debate behind it.
 *
 * Started detached and polled, not awaited in one request: Mastra wraps every
 * route in `timeout(server?.timeout ?? 180_000)`, and a board regularly runs
 * longer than that, failing with a 504 mid-run.
 */
export async function runBoardSession({
  baseUrl,
  question,
  threadId,
  signal,
  fetchImpl = fetch,
  pollIntervalMs = 2000,
  onRoundOne,
  resumeRunId,
}: RunBoardSessionOptions): Promise<BoardOutcome> {
  const workflow = `${baseUrl}/api/workflows/boardSession`;

  let runId = resumeRunId ?? "";

  if (resumeRunId) {
    // The board is mid-session, halted on a question: this message is the
    // answer, not a new question.
    const resumed = await fetchImpl(`${workflow}/resume?runId=${resumeRunId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: "ceo-question",
        resumeData: { answer: question },
      }),
      signal,
    });

    if (!resumed.ok) {
      const detail = await resumed.text().catch(() => resumed.statusText);
      throw new Error(`Board resume returned ${resumed.status}: ${detail}`);
    }
  } else {
    ({ runId } = await asJson<{ runId: string }>(
      await fetchImpl(`${workflow}/create-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal,
      }),
      "create-run",
    ));

    // Returns once scheduled; the board keeps working after this response closes.
    const started = await fetchImpl(`${workflow}/start?runId=${runId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputData: { question, threadId } }),
      signal,
    });

    if (!started.ok) {
      const detail = await started.text().catch(() => started.statusText);
      throw new Error(`Board start returned ${started.status}: ${detail}`);
    }
  }

  // Resuming: the openings already on screen are the pre-answer ones, and the
  // run reports `suspended` until it picks the answer up, so neither signal
  // means what it does on a fresh start.
  const resuming = Boolean(resumeRunId);
  let roundOneSent = resuming;
  let leftSuspended = !resuming;

  for (;;) {
    signal?.throwIfAborted();

    const snapshot = readSnapshot(
      await asJson<RunSnapshot & { snapshot?: RunSnapshot }>(
        await fetchImpl(`${workflow}/runs/${runId}`, { signal }),
        "run status",
      ),
    );

    const openings = snapshot.steps?.["render-openings"]?.output?.personas;
    if (!roundOneSent && openings?.length) {
      roundOneSent = true;
      onRoundOne?.(openings);
    }

    const status = snapshot.status;
    if (status && status !== "suspended") leftSuspended = true;

    if (status === "suspended" && leftSuspended) {
      return {
        status: "waiting",
        questions:
          snapshot.steps?.["ceo-question"]?.suspendPayload?.questions ?? [],
      };
    }

    if (status === "success") {
      const { answer, personas, objections, replies } = snapshot.result ?? {};
      // The debate alone is not a result: the CEO asked for a decision, so a
      // run that reached the end without one is a failure, not a partial board.
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

    if (status === "failed" || status === "canceled") {
      throw new Error(
        `Board run ${status}: ${JSON.stringify(snapshot.error ?? "no detail")}`,
      );
    }

    if (!status) {
      throw new Error(
        "Board run status is missing; refusing to poll a run we cannot read.",
      );
    }

    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
