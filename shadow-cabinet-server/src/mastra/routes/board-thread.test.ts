import { describe, expect, it } from "vitest";

import { nextMetadata } from "./board-thread.ts";

describe("nextMetadata", () => {
  it("leaves untouched fields alone", () => {
    const current = { pinned: true, readAt: "2026-08-18T12:00:00.000Z" };

    expect(nextMetadata(current, {})).toEqual(current);
  });

  it("keeps metadata the sidebar does not know about", () => {
    const current = { workingMemory: "kept", pinned: false };

    expect(nextMetadata(current, { pinned: true })).toEqual({
      workingMemory: "kept",
      pinned: true,
    });
  });

  it("sets the read timestamp", () => {
    const next = nextMetadata({}, { readAt: "2026-08-18T12:00:00.000Z" });

    expect(next.readAt).toBe("2026-08-18T12:00:00.000Z");
  });

  /**
   * The rule the first cut got wrong. The store merges metadata rather than
   * replacing it, so dropping the key leaves the old timestamp in place and the
   * board can never go back to unread — clearing has to write an explicit null.
   */
  it("clears the read timestamp to null rather than dropping the key", () => {
    const current = { readAt: "2026-08-18T12:00:00.000Z" };
    const next = nextMetadata(current, { readAt: null });

    expect(next.readAt).toBeNull();
    expect("readAt" in next).toBe(true);
  });

  it("does not touch the read timestamp when only pinning", () => {
    const current = { readAt: "2026-08-18T12:00:00.000Z" };

    expect(nextMetadata(current, { pinned: true })).toEqual({
      readAt: "2026-08-18T12:00:00.000Z",
      pinned: true,
    });
  });

  it("unpins", () => {
    expect(nextMetadata({ pinned: true }, { pinned: false })).toEqual({
      pinned: false,
    });
  });

  it("does not write the title into metadata", () => {
    expect(nextMetadata({}, { title: "Renamed" })).toEqual({});
  });
});
