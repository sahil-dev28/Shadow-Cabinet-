import type { UIMessage } from "ai";

const MASTRA_API_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";

// Single persona for now. Becomes dynamic once the rest of the board exists.
const AGENT_ID = "cfo-agent";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  let upstream: Response;
  try {
    upstream = await fetch(`${MASTRA_API_URL}/chat/${AGENT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      // Propagate client disconnects so Mastra aborts the in-flight generation.
      signal: req.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Cannot reach the board at ${MASTRA_API_URL}: ${message}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => upstream.statusText);
    return Response.json(
      { error: `Board returned ${upstream.status}: ${detail}` },
      { status: upstream.status },
    );
  }

  // Pipe the AI SDK UI message stream straight through to assistant-ui.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
