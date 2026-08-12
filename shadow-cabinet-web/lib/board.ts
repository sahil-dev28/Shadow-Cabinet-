type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface RunBoardSessionOptions {
  baseUrl: string;
  question: string;
  threadId: string;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  pollIntervalMs?: number;
}

export interface BoardEvidence {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
}

export interface BoardPersonaTurn {
  personaId: string;
  text: string;
  evidence: BoardEvidence[];
}

export interface BoardResult {
  transcript: string;
  personas: BoardPersonaTurn[];
  rebuttalsMarkdown: string;
}

interface RunSnapshot {
  status?: string;
  result?: Partial<BoardResult>;
  error?: unknown;
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
 * Runs one board session and returns its transcript.
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
}: RunBoardSessionOptions): Promise<BoardResult> {
  const workflow = `${baseUrl}/api/workflows/boardSession`;

  const { runId } = await asJson<{ runId: string }>(
    await fetchImpl(`${workflow}/create-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    }),
    "create-run",
  );

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

  for (;;) {
    signal?.throwIfAborted();

    const snapshot = readSnapshot(
      await asJson<RunSnapshot & { snapshot?: RunSnapshot }>(
        await fetchImpl(`${workflow}/runs/${runId}`, { signal }),
        "run status",
      ),
    );

    const status = snapshot.status;

    if (status === "success") {
      const { transcript, personas, rebuttalsMarkdown } = snapshot.result ?? {};
      if (!transcript) {
        throw new Error("Board run succeeded but returned no transcript.");
      }
      return {
        transcript,
        personas: personas ?? [],
        rebuttalsMarkdown: rebuttalsMarkdown ?? "",
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
