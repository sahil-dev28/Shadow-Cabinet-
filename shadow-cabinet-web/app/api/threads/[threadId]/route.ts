const MASTRA_API_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";

/**
 * The sidebar's per-thread actions, proxied to the board server.
 *
 * Same reasoning as the list route next door: the sidebar is a client
 * component, so it cannot read `MASTRA_API_URL` itself, and a relative fetch
 * would hit this app's `/board/…` page rather than the board server's route.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;

  try {
    const response = await fetch(
      `${MASTRA_API_URL}/board/threads/${encodeURIComponent(threadId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      },
    );

    // The status is forwarded rather than flattened: the sidebar rolls its
    // optimistic change back on a failure, and it can only tell one happened
    // if the failure survives the proxy.
    return Response.json(await response.json().catch(() => ({})), {
      status: response.status,
    });
  } catch {
    return Response.json({ error: "Board server unreachable" }, { status: 502 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;

  try {
    const response = await fetch(
      `${MASTRA_API_URL}/board/threads/${encodeURIComponent(threadId)}`,
      { method: "DELETE" },
    );

    return Response.json(await response.json().catch(() => ({})), {
      status: response.status,
    });
  } catch {
    return Response.json({ error: "Board server unreachable" }, { status: 502 });
  }
}
