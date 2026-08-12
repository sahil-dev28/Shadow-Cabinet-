import type { UIMessage } from "ai";

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
 * so a browser client sees no prose. We run the workflow to completion over
 * the REST API instead and re-emit its transcript as one AI SDK UI message.
 */
function transcriptStream(transcript: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = "board-transcript";

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse({ type: "start" })));
      controller.enqueue(encoder.encode(sse({ type: "text-start", id })));

      // Chunked so the transcript paints progressively instead of in one jump.
      for (let i = 0; i < transcript.length; i += 512) {
        controller.enqueue(
          encoder.encode(
            sse({ type: "text-delta", id, delta: transcript.slice(i, i + 512) }),
          ),
        );
      }

      controller.enqueue(encoder.encode(sse({ type: "text-end", id })));
      controller.enqueue(encoder.encode(sse({ type: "finish" })));
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

  let transcript: string;
  try {
    const created = await fetch(
      `${MASTRA_API_URL}/api/workflows/boardSession/create-run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: req.signal,
      },
    );

    if (!created.ok) {
      const detail = await created.text().catch(() => created.statusText);
      return Response.json(
        { error: `Board returned ${created.status}: ${detail}` },
        { status: created.status },
      );
    }

    const { runId } = (await created.json()) as { runId: string };

    const run = await fetch(
      `${MASTRA_API_URL}/api/workflows/boardSession/start-async?runId=${runId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputData: { question, threadId } }),
        signal: req.signal,
      },
    );

    if (!run.ok) {
      const detail = await run.text().catch(() => run.statusText);
      return Response.json(
        { error: `Board returned ${run.status}: ${detail}` },
        { status: run.status },
      );
    }

    const result = (await run.json()) as {
      status?: string;
      result?: { transcript?: string };
      error?: unknown;
    };

    if (result.status !== "success" || !result.result?.transcript) {
      return Response.json(
        { error: `Board run did not complete: ${JSON.stringify(result.error ?? result.status)}` },
        { status: 502 },
      );
    }

    transcript = result.result.transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Cannot reach the board at ${MASTRA_API_URL}: ${message}` },
      { status: 502 },
    );
  }

  return new Response(transcriptStream(transcript), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
