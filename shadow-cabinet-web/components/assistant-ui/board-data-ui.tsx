"use client";

import { useAssistantDataUI } from "@assistant-ui/react";

import type { BoardDebate, BoardWaiting } from "@/lib/debate";
import { BoardDebateSection } from "@/components/assistant-ui/board-debate";
import { BoardWaitingNotice } from "@/components/assistant-ui/board-waiting";

/**
 * Registers the board's data renderers for as long as it is mounted. Rendered
 * inside AssistantRuntimeProvider — the hook writes into runtime context, so it
 * throws outside one.
 *
 * The names are bare: the wire format is `data-<name>` and the runtime part
 * arrives with the prefix already stripped. One renderer per call, so a message
 * carrying both a debate and a pause needs both registrations.
 */
export function BoardDataUI({ threadId }: { threadId: string }) {
  useAssistantDataUI({
    name: "board-debate",
    render: ({ data }: { data: BoardDebate }) => (
      <BoardDebateSection data={data} threadId={threadId} />
    ),
  });

  useAssistantDataUI({
    name: "board-waiting",
    render: ({ data }: { data: BoardWaiting }) => (
      <BoardWaitingNotice data={data} />
    ),
  });

  return null;
}
