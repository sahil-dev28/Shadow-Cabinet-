import type { UIMessage } from "ai";

import { runBoardSession } from "@/lib/board";
import type { BoardDebate, BoardWaiting } from "@/lib/debate";
import { isPersonaId, type PersonaId } from "@/lib/personas";

const MASTRA_API_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";

// A contested board is nine agent calls with tool use; answering a paused one
// adds a revision round on top and has measured over nine minutes. Serverless
// platforms cap well below this — see the README on running the board.
export const maxDuration = 800;

function lastUserText(messages: UIMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");

  return (lastUser?.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Mastra's `workflowRoute` emits workflow lifecycle events, not UI parts, so
 * the board is rebuilt here as AI SDK UI parts.
 *
 * One message, not one per persona: repeated start/finish envelopes accumulate
 * into each other and re-render every earlier part under the next one.
 */
type Write = (event: unknown) => void;

/**
 * The whole debate rides in one part rather than as prose, so the answer stays
 * the message and the argument stays a section the CEO can fold away.
 *
 * Always this id: a data part is replaced in place when a later one repeats its
 * type and id, which is what lets round one go out early and be overwritten by
 * the finished debate without the openings appearing twice.
 */
const DEBATE_PART_ID = "board-debate";

function writeDebate(write: Write, debate: BoardDebate): void {
  write({ type: "data-board-debate", id: DEBATE_PART_ID, data: debate });
}

/** The board halted: who asked what, so the pause never reads as a stall. */
function writeWaiting(write: Write, waiting: BoardWaiting): void {
  write({ type: "data-board-waiting", id: "board-waiting", data: waiting });
}

/**
 * Deliberately not fault-tolerant: if we cannot tell whether the board is
 * halted, guessing "not halted" convenes a second board on the same thread and
 * strands the first mid-question. Failing here is the cheaper mistake.
 */
async function pendingRunId(
  threadId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(`${MASTRA_API_URL}/board/${threadId}/messages`, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(
      `Could not read board state (${response.status}): ${detail}`,
    );
  }

  const { pending } = (await response.json()) as {
    pending?: { runId?: string } | null;
  };
  return pending?.runId;
}

/**
 * A board session is nine agent calls and several minutes, so a greeting gets a
 * direct reply instead. Skipped while a board is halted mid-question: whatever
 * the CEO types then is the answer, however short.
 */
async function reception(
  question: string,
  signal: AbortSignal,
): Promise<{ convene: boolean; reply: string }> {
  const response = await fetch(`${MASTRA_API_URL}/board/reception`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    cache: "no-store",
    signal,
  });

  if (!response.ok) return { convene: true, reply: "" };

  return (await response.json()) as { convene: boolean; reply: string };
}

/**
 * A question put to one executive is one agent call, so it skips the reception
 * gate, the halted-run check, and the workflow: there is nothing to debate and
 * no chair to synthesise it. Mastra's own stream already carries the reply and
 * the tool calls behind it, and the thread's chain-of-thought card renders
 * those as "Checked N figures" — which is how a targeted reply shows its
 * evidence without a debate section to sit in.
 */
async function askOneExecutive(
  persona: PersonaId,
  question: string,
  threadId: string,
  signal: AbortSignal,
): Promise<Response> {
  const upstream = await fetch(`${MASTRA_API_URL}/chat/${persona}-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `memory` sits at the top level because `chatRoute` spreads everything but
    // `messages` straight into the agent's execution options. The board's own
    // resource and thread, so the question and its answer land where the board
    // reads them on its next turn — which is also why only the new question is
    // sent: the rest of the thread is already in that memory.
    body: JSON.stringify({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: question }],
        },
      ],
      memory: { resource: "ceo", thread: threadId },
    }),
    signal,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

export async function POST(req: Request) {
  const {
    messages,
    threadId,
    target = "board",
  }: { messages: UIMessage[]; threadId?: string; target?: string } =
    await req.json();

  const question = lastUserText(messages);
  if (!question) {
    return Response.json({ error: "No question to put to the board." }, { status: 400 });
  }
  if (!threadId) {
    return Response.json({ error: "Missing threadId." }, { status: 400 });
  }

  if (target !== "board") {
    if (!isPersonaId(target)) {
      return Response.json(
        { error: `No such executive: ${target}.` },
        { status: 400 },
      );
    }

    return askOneExecutive(target, question, threadId, req.signal);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write: Write = (event) =>
        controller.enqueue(encoder.encode(sse(event)));

      write({ type: "start", messageId: "board-session" });

      try {
        const resumeRunId = await pendingRunId(threadId, req.signal);

        if (!resumeRunId) {
          const { convene, reply } = await reception(question, req.signal);

          if (!convene && reply.trim()) {
            const id = "board-reception";
            write({ type: "text-start", id });
            write({ type: "text-delta", id, delta: reply });
            write({ type: "text-end", id });
            write({ type: "finish" });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
        }

        const board = await runBoardSession({
          baseUrl: MASTRA_API_URL,
          question,
          threadId,
          signal: req.signal,
          resumeRunId,
          // Round one lands roughly ninety seconds before the run ends, so the
          // positions go out as a debate with the later rounds still empty
          // rather than making the CEO watch a spinner until the chair speaks.
          onRoundOne: (openings) =>
            writeDebate(write, { openings, objections: [], replies: [] }),
        });

        if (board.status === "waiting") {
          writeWaiting(write, { questions: board.questions });
        } else {
          // Written before the answer, though it is read after it: parts render
          // in stream order, so the debate section places itself beneath the
          // answer by layout rather than by arrival.
          writeDebate(write, board.debate);

          const id = "board-answer";
          write({ type: "text-start", id });
          write({ type: "text-delta", id, delta: board.answer });
          write({ type: "text-end", id });
        }
      } catch (error) {
        // Reported in-stream rather than as a status code: by the time a board
        // fails, the opening round may already be on screen.
        const message = error instanceof Error ? error.message : String(error);
        write({
          type: "error",
          errorText: `Board session failed (${MASTRA_API_URL}): ${message}`,
        });
      }

      write({ type: "finish" });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
