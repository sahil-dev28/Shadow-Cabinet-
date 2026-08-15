import { registerApiRoute } from "@mastra/core/server";

import { type ThreadStatus, listBoardSessions } from "../data/board-sessions.ts";
import { getPendingRun } from "../data/pending-runs.ts";

/**
 * Board history for one thread, as the CEO saw it: the question, the chair's
 * answer, and the three rounds behind it with the lookups each executive made.
 *
 * Deliberately not the agent thread. That stores every internal prompt as a
 * user turn — one question appears four times, once per persona — so replaying
 * it would show the plumbing rather than the board.
 */
export const boardHistoryRoute = registerApiRoute("/board/:threadId/messages", {
  method: "GET",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const [sessions, pending] = await Promise.all([
      listBoardSessions(threadId),
      getPendingRun(threadId),
    ]);

    // Derived, not stored: a halted run is the only thing that outranks a
    // finished session, and a thread with neither has a board still running.
    const status: ThreadStatus = pending
      ? "waiting_on_ceo"
      : sessions.length > 0
        ? "resolved"
        : "running";

    return c.json({
      sessions: sessions.map(
        ({ question, answer, personas, objections, replies }) => ({
          question,
          answer,
          personas,
          objections,
          replies,
        }),
      ),
      // Set while the board is halted waiting on the CEO.
      pending,
      status,
    });
  },
});
