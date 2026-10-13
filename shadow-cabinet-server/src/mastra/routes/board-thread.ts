import { registerApiRoute } from "@mastra/core/server";

import { deleteBoardSessions } from "../data/board-sessions.ts";
import { clearPendingRun } from "../data/pending-runs.ts";

/**
 * What the sidebar remembers about a board beyond its name.
 *
 * Kept on the Mastra thread rather than in a store of its own: the title is
 * already there, so a rename and a pin are one write against one row instead
 * of two records that can drift apart.
 */
export interface BoardThreadMetadata extends Record<string, unknown> {
  pinned?: boolean;
  /**
   * When the CEO last opened this board. Absent or `null` means never.
   *
   * Nullable rather than optional because the store merges metadata rather
   * than replacing it — see the `readAt` handling in the PATCH below.
   */
  readAt?: string | null;
}

export interface ThreadPatch {
  title?: string;
  pinned?: boolean;
  /** `null` clears it — that is what "mark as unread" writes. */
  readAt?: string | null;
}

/**
 * The metadata to store for a thread once a patch is applied.
 *
 * Pulled out of the handler because this is the part that can be wrong. The
 * store merges rather than replaces — `{ ...thread.metadata, ...metadata }` —
 * so a key left out of the write is one the merge quietly preserves. Clearing
 * `readAt` therefore has to write an explicit `null`; deleting the key keeps
 * the old timestamp, and the board can never be marked unread again.
 */
export function nextMetadata(
  current: BoardThreadMetadata,
  patch: ThreadPatch,
): BoardThreadMetadata {
  const next: BoardThreadMetadata = { ...current };

  // Absent leaves the stored value alone; present overwrites it, `null`
  // included.
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.readAt !== undefined) next.readAt = patch.readAt;

  return next;
}

/**
 * Per-thread actions behind the sidebar's three-dot menu.
 *
 * Split from `board-threads.ts` on purpose: that route answers "which boards
 * are there", which has to reconcile two stores, while these change one board
 * and are better read next to each other than folded into that reconciliation.
 */
export const boardThreadRoute = registerApiRoute("/board/threads/:threadId", {
  method: "PATCH",
  createHandler: async ({ mastra }) => {
    return async (c) => {
      const threadId = c.req.param("threadId");
      const patch = (await c.req.json()) as ThreadPatch;

      // Any persona will do: they hold separate `Memory` instances but share
      // the one store the Mastra instance was built with.
      const agent = mastra.getAgentById("cfo-agent");
      const memory = await agent.getMemory();

      const thread = await memory?.getThreadById({ threadId });
      // Metadata has to hang off something. A thread the board never ran on has
      // no record to hang it from, and inventing one here would put a titleless
      // row in a sidebar that lists from the sessions anyway.
      if (!thread) return c.json({ error: "Unknown thread" }, 404);

      const metadata = (thread.metadata ?? {}) as BoardThreadMetadata;
      const next = nextMetadata(metadata, patch);

      const title = patch.title?.trim();

      await memory?.updateThread({
        id: threadId,
        // Required by the signature even when only metadata is changing, so the
        // existing name is read back rather than blanked.
        title: title || thread.title || "",
        metadata: next,
      });

      return c.json({ ok: true });
    };
  },
});

/**
 * Removes a board outright: its sessions, any run halted on it, and the agent
 * thread behind it.
 *
 * The order matters. Sessions are what the sidebar lists from, so they go
 * first — a delete that dies halfway then leaves no row rather than a row
 * whose memory is already gone. Mastra's thread goes last for the same reason.
 */
export const boardThreadDeleteRoute = registerApiRoute(
  "/board/threads/:threadId",
  {
    method: "DELETE",
    createHandler: async ({ mastra }) => {
      return async (c) => {
        const threadId = c.req.param("threadId");

        await deleteBoardSessions(threadId);
        // A halted run left behind would resume into a thread with no history.
        await clearPendingRun(threadId);

        const agent = mastra.getAgentById("cfo-agent");
        const memory = await agent.getMemory();

        // Swallowed: the board is already gone from everything the CEO can see,
        // and failing here would report a delete that visibly happened.
        await memory?.deleteThread(threadId).catch(() => undefined);

        return c.json({ ok: true });
      };
    },
  },
);
