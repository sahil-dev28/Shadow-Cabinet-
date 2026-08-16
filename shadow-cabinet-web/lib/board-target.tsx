"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import type { BoardTarget } from "@/lib/personas";

/**
 * The composer picks who answers; the transport that sends the message lives in
 * `app/assistant.tsx`, several levels above it. Context carries the choice
 * between the two rather than threading a prop through `<Thread />`.
 */
const BoardTargetContext = createContext<{
  target: BoardTarget;
  setTarget: (target: BoardTarget) => void;
}>({ target: "board", setTarget: () => {} });

/** "board" by default: addressing one executive is the exception. */
export function BoardTargetProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<BoardTarget>("board");
  const value = useMemo(() => ({ target, setTarget }), [target]);

  return <BoardTargetContext value={value}>{children}</BoardTargetContext>;
}

export const useBoardTarget = () => useContext(BoardTargetContext);
