import { describe, expect, it } from "vitest";

import { type BoardThread, groupThreads, isUnread } from "./board-threads";

function thread(overrides: Partial<BoardThread> = {}): BoardThread {
  return {
    threadId: "board-1",
    title: "Freight brokerage exit",
    updatedAt: "2026-08-18T12:00:00.000Z",
    answeredAt: "2026-08-18T12:00:00.000Z",
    pinned: false,
    readAt: null,
    ...overrides,
  };
}

describe("isUnread", () => {
  it("treats a board that was never opened as unread", () => {
    expect(isUnread(thread({ readAt: null }))).toBe(true);
  });

  it("marks a board that answered after the last read as unread", () => {
    const row = thread({
      readAt: "2026-08-18T12:00:00.000Z",
      answeredAt: "2026-08-18T12:30:00.000Z",
    });

    expect(isUnread(row)).toBe(true);
  });

  it("marks a board read when the last read came after the answer", () => {
    const row = thread({
      answeredAt: "2026-08-18T12:00:00.000Z",
      readAt: "2026-08-18T12:30:00.000Z",
    });

    expect(isUnread(row)).toBe(false);
  });

  /**
   * The bug this rule exists to avoid: Mastra's `updatedAt` moves on the very
   * write that stamps `readAt`, so a row keyed off it could never be read.
   */
  it("ignores Mastra's clock moving after the read", () => {
    const row = thread({
      answeredAt: "2026-08-18T12:00:00.000Z",
      readAt: "2026-08-18T12:30:00.000Z",
      updatedAt: "2026-08-18T13:00:00.000Z",
    });

    expect(isUnread(row)).toBe(false);
  });
});

describe("groupThreads", () => {
  it("returns one unlabelled group when nothing is pinned", () => {
    const rows = [thread({ threadId: "a" }), thread({ threadId: "b" })];

    expect(groupThreads(rows)).toEqual([{ label: null, threads: rows }]);
  });

  it("puts pinned boards in their own group above the rest", () => {
    const pinned = thread({ threadId: "a", pinned: true });
    const loose = thread({ threadId: "b" });

    expect(groupThreads([loose, pinned])).toEqual([
      { label: "Pinned", threads: [pinned] },
      { label: "Recent", threads: [loose] },
    ]);
  });

  it("holds the server's order inside each group", () => {
    const rows = [
      thread({ threadId: "a", pinned: true }),
      thread({ threadId: "b" }),
      thread({ threadId: "c", pinned: true }),
    ];

    const [pinned, rest] = groupThreads(rows);

    expect(pinned.threads.map((row) => row.threadId)).toEqual(["a", "c"]);
    expect(rest.threads.map((row) => row.threadId)).toEqual(["b"]);
  });

  it("drops the empty group when everything is pinned", () => {
    const rows = [thread({ threadId: "a", pinned: true })];

    expect(groupThreads(rows)).toEqual([{ label: "Pinned", threads: rows }]);
  });

  it("returns an empty ungrouped list when there are no boards", () => {
    expect(groupThreads([])).toEqual([{ label: null, threads: [] }]);
  });
});
