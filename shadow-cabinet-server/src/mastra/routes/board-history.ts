import { registerApiRoute } from "@mastra/core/server";

import { listBoardSessions } from "../data/board-sessions.ts";
import { getPendingRun } from "../data/pending-runs.ts";

/**
 * Board history for one thread, as the CEO saw it: the question, each
 * executive's opening with the lookups behind it, and the debate round.
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

    return c.json({
      sessions: sessions.map(({ question, personas, rebuttalsMarkdown }) => ({
        question,
        personas,
        rebuttalsMarkdown,
      })),
      // Set while the board is halted waiting on the CEO.
      pending,
    });
  },
});
