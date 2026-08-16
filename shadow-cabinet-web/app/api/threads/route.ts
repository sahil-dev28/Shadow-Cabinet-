const MASTRA_API_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";

/**
 * Proxies the board's thread list to the browser.
 *
 * The sidebar renders inside the assistant's client boundary, so it cannot read
 * `MASTRA_API_URL` itself — that stays server-side, as it does for the chat
 * proxy next door. A relative fetch would also be wrong on its own: `/board/…`
 * on this origin is the board page, not the board server.
 */
export async function GET() {
  try {
    const response = await fetch(`${MASTRA_API_URL}/board/threads`, {
      // The list changes whenever a board finishes, which is not something a
      // cached response would ever notice.
      cache: "no-store",
    });

    if (!response.ok) return Response.json({ threads: [] });

    return Response.json(await response.json());
  } catch {
    // A sidebar that cannot reach the board server shows no past boards. It
    // must not take the page down with it — the thread being read still works.
    return Response.json({ threads: [] });
  }
}
