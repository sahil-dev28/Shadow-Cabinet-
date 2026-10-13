/** One row in the sidebar, as `GET /api/threads` sends it. */
export interface BoardThread {
  threadId: string;
  title: string;
  /** Mastra's clock: moves on every agent turn. The sidebar sorts by this. */
  updatedAt: string;
  /** The session's clock: moves only when a board produces an answer. */
  answeredAt: string;
  pinned: boolean;
  /** When the CEO last opened this board. `null` means never. */
  readAt: string | null;
}

/**
 * A board is unread when it answered after the CEO last opened it.
 *
 * Keyed off `answeredAt` and never off `updatedAt`. Mastra's clock ticks on
 * every agent turn — including the write that stamps `readAt` — so a row keyed
 * off it would go unread again the instant it was marked read. The session
 * clock moves only on an answer, which is the event this is trying to name.
 */
export function isUnread(thread: BoardThread): boolean {
  if (!thread.readAt) return true;

  return thread.answeredAt > thread.readAt;
}

export interface BoardThreadGroup {
  /** `null` for the ungrouped remainder, so it renders without a heading. */
  label: string | null;
  threads: BoardThread[];
}

/**
 * Pinned boards first, under their own heading; everything else below it in the
 * order the server sent.
 *
 * Both groups are dropped when empty rather than rendered as a heading over
 * nothing — with no pins there is only one list, and labelling it "Recent"
 * would name a distinction that is not on screen.
 */
export function groupThreads(threads: BoardThread[]): BoardThreadGroup[] {
  const pinned = threads.filter((thread) => thread.pinned);
  const rest = threads.filter((thread) => !thread.pinned);

  if (pinned.length === 0) return [{ label: null, threads: rest }];
  if (rest.length === 0) return [{ label: "Pinned", threads: pinned }];

  return [
    { label: "Pinned", threads: pinned },
    { label: "Recent", threads: rest },
  ];
}
