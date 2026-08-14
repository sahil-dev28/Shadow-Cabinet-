import type { UIMessage } from "ai";

import {
  type BoardResult,
  type CeoQuestion,
  runBoardSession,
} from "@/lib/board";
import { personaHeading } from "@/lib/personas";

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
 * Mastra's `workflowRoute` emits workflow lifecycle events, not text parts, so
 * the rounds are rebuilt here as AI SDK UI parts.
 *
 * One message, not one per persona: repeated start/finish envelopes accumulate
 * into each other and re-render every earlier executive under the next one.
 * `groupPartByType` groups consecutive parts, so each persona still collapses
 * separately as long as its text sits between its calls and the next persona's.
 */
type Write = (event: unknown) => void;

function writeOpenings(write: Write, personas: BoardResult["personas"]): void {
  for (const persona of personas) {
    const id = `${persona.personaId}-opening`;

    // Evidence precedes the position it supports.
    for (const call of persona.evidence) {
      write({
        type: "tool-input-available",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
      write({
        type: "tool-output-available",
        toolCallId: call.toolCallId,
        output: call.output,
      });
    }

    write({ type: "text-start", id });
    write({
      type: "text-delta",
      id,
      delta: `${personaHeading(persona.personaId)}\n\n${persona.text.trim()}\n`,
    });
    write({ type: "text-end", id });
  }
}

/** The board halted: name who asked what, so the pause never looks like a stall. */
function waitingMarkdown(questions: CeoQuestion[]): string {
  const asks = questions
    .map((q) => `**${q.personaId.toUpperCase()} asks:** ${q.question}`)
    .join("\n\n");

  return `\n## The board is waiting on you\n\n${asks}\n\nAnswer in the box below and the board resumes where it stopped.\n`;
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

export async function POST(req: Request) {
  const { messages, threadId }: { messages: UIMessage[]; threadId?: string } =
    await req.json();

  const question = lastUserText(messages);
  if (!question) {
    return Response.json({ error: "No question to put to the board." }, { status: 400 });
  }
  if (!threadId) {
    return Response.json({ error: "Missing threadId." }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write: Write = (event) =>
        controller.enqueue(encoder.encode(sse(event)));

      write({ type: "start", messageId: "board-session" });

      let openingsSent = false;

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
          onRoundOne: (personas) => {
            openingsSent = true;
            writeOpenings(write, personas);
          },
        });

        if (board.status === "waiting") {
          const id = "board-waiting";
          write({ type: "text-start", id });
          write({ type: "text-delta", id, delta: waitingMarkdown(board.questions) });
          write({ type: "text-end", id });
        } else {
          // A run that finishes between polls never fires the callback.
          if (!openingsSent) writeOpenings(write, board.personas);

          if (board.rebuttalsMarkdown.trim()) {
            const id = "board-rebuttals";
            write({ type: "text-start", id });
            write({ type: "text-delta", id, delta: `\n${board.rebuttalsMarkdown}` });
            write({ type: "text-end", id });
          }
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
