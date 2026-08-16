"use client";

import { useCallback, useEffect, useState } from "react";

const key = (threadId: string) => `shadow-cabinet:debate:${threadId}`;

/**
 * Open on a thread's first answer, then whatever the CEO last chose. Reads on
 * mount rather than during render: `localStorage` does not exist on the server,
 * and touching it during render makes the first client paint disagree with the
 * server's, which React reports as a hydration error.
 */
export function useDebateOpen(
  threadId: string,
): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const stored = window.localStorage.getItem(key(threadId));
    if (stored !== null) setOpen(stored === "open");
  }, [threadId]);

  const choose = useCallback(
    (next: boolean) => {
      setOpen(next);
      window.localStorage.setItem(key(threadId), next ? "open" : "closed");
    },
    [threadId],
  );

  return [open, choose];
}
