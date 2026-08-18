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
   * Fires every time the debate visibly grows — after the openings, after the
   * objections, after the replies, and once more if the board halts — carrying
   * the fullest state known at that moment, so the CEO watches the argument
   * build instead of watching a spinner for the whole run.
   *
   * Three beats, not twelve: `foreach` publishes a round as one array, so a
   * single executive finishing early is not observable.
   */
  onProgress?: (debate: BoardDebate) => void;
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
      /** Shaped per step, so each reader below narrows it rather than the type. */
      output?: unknown;
      suspendPayload?: { questions?: CeoQuestion[] };
    }
  >;
}

/** Round two as the step leaves it: the objection plus the state round three needs. */
type RebuttalEntry = BoardObjection & Record<string, unknown>;

/** Round three as the step leaves it; `personaId` is null on the placeholder. */
interface ReplyEntry {
  personaId: string | null;
  text: string;
}

function readOpenings(output: unknown): BoardPersonaTurn[] | undefined {
  const personas = (output as { personas?: BoardPersonaTurn[] } | undefined)
    ?.personas;
  return personas?.length ? personas : undefined;
}

/**
 * Round two carries the whole of round one along with every entry so the third
 * fan-out has something to work from; the UI wants none of that plumbing.
 */
function readObjections(output: unknown): BoardObjection[] | undefined {
  if (!Array.isArray(output)) return undefined;

  return (output as RebuttalEntry[]).map((entry) => ({
    personaId: entry.personaId,
    disagrees: entry.disagrees,
    with: entry.with ?? [],
    statement: entry.statement ?? "",
  }));
}

/**
 * An unopposed board still fans one persona-less item through round three so the
 * debate state survives to be rendered. It is plumbing, not a reply, so an empty
 * array here means "nobody needed to reply", not "the round has not run".
 */
function readReplies(output: unknown): BoardReply[] | undefined {
  if (!Array.isArray(output)) return undefined;

  return (output as ReplyEntry[])
    .filter((entry) => entry.personaId !== null)
    .map((entry) => ({ personaId: entry.personaId as string, text: entry.text }));
}

/** The three observable beats, in the order the workflow publishes them. */
const ROUNDS = ["openings", "objections", "replies"] as const;

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
  onProgress,
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

  // Resuming: the run still reports `suspended` until it picks the answer up,
  // so that status does not mean on a resume what it means on a fresh start.
  const resuming = Boolean(resumeRunId);
  // Index into `ROUNDS` of the last beat handed over, so a round is reported on
  // the poll that first exposes it and never again. A resumed board reports its
  // openings afresh: the stream reuses one message id, so answering the board
  // replaces the message the openings were in.
  let reported = -1;
  let leftSuspended = !resuming;
  let latest: BoardDebate | undefined;

  for (;;) {
    signal?.throwIfAborted();

    const snapshot = readSnapshot(
      await asJson<RunSnapshot & { snapshot?: RunSnapshot }>(
        await fetchImpl(`${workflow}/runs/${runId}`, { signal }),
        "run status",
      ),
    );

    const steps = snapshot.steps ?? {};
    const openings = readOpenings(steps["render-openings"]?.output);

    if (openings) {
      const objections = readObjections(steps["rebuttal"]?.output);
      const replies = readReplies(steps["reply"]?.output);
      const round = replies ? 2 : objections ? 1 : 0;

      const debate: BoardDebate = {
        openings,
        objections: objections ?? [],
        replies: replies ?? [],
        phase: ROUNDS[round],
      };
      latest = debate;

      if (round > reported) {
        reported = round;
        onProgress?.(debate);
      }
    }

    const status = snapshot.status;
    if (status && status !== "suspended") leftSuspended = true;

    if (status === "suspended" && leftSuspended) {
      // A halted board is not a working one. Without this the objections would
      // sit under a spinner that never resolves, because nothing is running.
      if (latest) onProgress?.({ ...latest, phase: "paused" });

      return {
        status: "waiting",
        questions: steps["ceo-question"]?.suspendPayload?.questions ?? [],
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
          phase: "complete",
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
