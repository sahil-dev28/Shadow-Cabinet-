import type { UIMessage } from "ai";

import { type BoardResult, runBoardSession } from "@/lib/board";

const PERSONA_TITLES: Record<string, string> = {
  cfo: "Chief Financial Officer",
  cmo: "Chief Marketing Officer",
  coo: "Chief Operating Officer",
  cso: "Chief Strategy Officer",
};

const MASTRA_API_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";

// Eight agent calls with tool use. A contested board takes minutes, not seconds.
export const maxDuration = 300;

/** assistant-ui sends UIMessages; the workflow wants a single question string. */
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
 * Mastra's `workflowRoute` streams workflow lifecycle events, not text parts,
 * so a browser client sees no prose, and the agents' own tool calls never leave
 * the server. We drive the workflow over the REST API and rebuild the rounds as
 * AI SDK UI messages: one message per executive, carrying that executive's own
 * grounding calls as tool parts, then one message for the debate round.
 *
 * It is one message, not one per persona: repeated start/finish envelopes in a
 * single response accumulate into each other rather than producing separate
 * messages, which renders every earlier executive again under the next one.
 * Independent collapsing does not need separate messages — `groupPartByType`
 * groups consecutive parts, so each persona's tool calls form their own group
 * as long as that persona's text sits between them and the next persona's.
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
        const title = PERSONA_TITLES[persona.personaId] ?? persona.personaId;

        // Tool parts first: the evidence precedes the position it supports, and
        // both call and result are already complete, so nothing animates open.
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
          delta: `### ${persona.personaId.toUpperCase()} — ${title}\n\n${persona.text.trim()}\n`,
        });
        write(controller, { type: "text-end", id });
      }

      // The debate round stays plain prose: no tool parts, so nothing to
      // collapse, and the disagreements render expanded as the spec requires.
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
