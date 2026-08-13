import type { UIMessage } from "ai";

import { type BoardResult, runBoardSession } from "@/lib/board";
import { personaHeading } from "@/lib/personas";

const MASTRA_API_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";

// Eight agent calls with tool use. A contested board takes minutes, not seconds.
export const maxDuration = 300;

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
        const board = await runBoardSession({
          baseUrl: MASTRA_API_URL,
          question,
          threadId,
          signal: req.signal,
          onRoundOne: (personas) => {
            openingsSent = true;
            writeOpenings(write, personas);
          },
        });

        // A run that finishes between polls never fires the callback.
        if (!openingsSent) writeOpenings(write, board.personas);

        if (board.rebuttalsMarkdown.trim()) {
          const id = "board-rebuttals";
          write({ type: "text-start", id });
          write({ type: "text-delta", id, delta: `\n${board.rebuttalsMarkdown}` });
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
