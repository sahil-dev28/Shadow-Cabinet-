import { registerApiRoute } from "@mastra/core/server";

import { listBoardThreads } from "../data/board-sessions.ts";

/** Every board thread belongs to the same CEO in this prototype. */
const RESOURCE_ID = "ceo";

const TITLE_LIMIT = 60;

/**
 * A thread the namer never reached is labelled by the question that opened it.
 * Every thread answered before titling shipped is in this case, as is any
 * thread whose naming call failed.
 */
function fallbackTitle(question: string): string {
  const collapsed = question.trim().replace(/\s+/g, " ");

  return collapsed.length > TITLE_LIMIT
    ? `${collapsed.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
    : collapsed;
}

/**
 * The sidebar's list of past boards.
 *
 * Two stores have to agree here. Titles live on the Mastra thread, written by
 * the chair step once per thread; the questions behind them live in the board
 * sessions. Neither alone is enough — Mastra knows the name but not the
 * question, and the sessions know the question but never the name.
 */
export const boardThreadsRoute = registerApiRoute("/board/threads", {
  method: "GET",
  createHandler: async ({ mastra }) => {
    return async (c) => {
      const stored = await listBoardThreads();

      // Any persona will do: they hold separate `Memory` instances but share
      // the one store the Mastra instance was built with.
      const agent = mastra.getAgentById("cfo-agent");
      const memory = await agent.getMemory();

      const listed = await memory
        ?.listThreads({ filter: { resourceId: RESOURCE_ID }, perPage: false })
        // A listing failure must not blank the sidebar: the stored sessions
        // alone still render every thread, under its question rather than its
        // name, which is already the path an untitled thread takes.
        .catch(() => undefined);

      const titles = new Map<string, string>();
      const touchedAt = new Map<string, string>();
      for (const thread of listed?.threads ?? []) {
        const title = thread.title?.trim();
        if (title) titles.set(thread.id, title);

        const touched = new Date(thread.updatedAt);
        if (!Number.isNaN(touched.getTime())) {
          touchedAt.set(thread.id, touched.toISOString());
        }
      }

      const threads = stored
        .map((thread) => ({
          threadId: thread.threadId,
          title:
            titles.get(thread.threadId) ?? fallbackTitle(thread.firstQuestion),
          // Mastra's clock moves on every agent turn, the session's only when a
          // board finishes. Prefer Mastra's so a resumed thread sorts as recent.
          updatedAt: touchedAt.get(thread.threadId) ?? thread.updatedAt,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      // Deliberately keyed off the stored sessions rather than off Mastra's
      // threads: a thread Mastra knows but no session does is a board that
      // never reached an answer, and it has neither a title nor a question to
      // show. Listing it would put a raw uuid in the sidebar.
      return c.json({ threads });
    };
  },
});
