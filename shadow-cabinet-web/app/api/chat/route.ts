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
function boardStream(board: BoardResult): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  const write = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: unknown,
  ) => controller.enqueue(encoder.encode(sse(event)));

  return new ReadableStream({
    start(controller) {
      write(controller, { type: "start", messageId: "board-session" });

      for (const persona of board.personas) {
        const id = `${persona.personaId}-opening`;

        // Evidence precedes the position it supports.
        for (const call of persona.evidence) {
          write(controller, {
            type: "tool-input-available",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          });
          write(controller, {
            type: "tool-output-available",
            toolCallId: call.toolCallId,
            output: call.output,
          });
        }

        write(controller, { type: "text-start", id });
        write(controller, {
          type: "text-delta",
          id,
          delta: `${personaHeading(persona.personaId)}\n\n${persona.text.trim()}\n`,
        });
        write(controller, { type: "text-end", id });
      }

      // No tool parts here, so the debate round renders expanded per the spec.
      if (board.rebuttalsMarkdown.trim()) {
        const id = "board-rebuttals";
        write(controller, { type: "text-start", id });
        write(controller, {
          type: "text-delta",
          id,
          delta: `\n${board.rebuttalsMarkdown}`,
        });
        write(controller, { type: "text-end", id });
      }

      write(controller, { type: "finish" });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
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

  let board: BoardResult;
  try {
    board = await runBoardSession({
      baseUrl: MASTRA_API_URL,
      question,
      threadId,
      signal: req.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Board session failed (${MASTRA_API_URL}): ${message}` },
      { status: 502 },
    );
  }

  return new Response(boardStream(board), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
