import type { UIMessage } from "ai";

import type {
  BoardDebate,
  BoardObjection,
  BoardPersonaTurn,
  BoardReply,
} from "./debate";

interface BoardHistorySession {
  question: string;
  /** Absent on sessions stored before the chair existed. */
  answer?: string;
  personas: BoardPersonaTurn[];
  objections: BoardObjection[];
  replies: BoardReply[];
}

/**
 * Rebuilds past board sessions as UI messages in the same shape the live stream
 * produces — the chair's answer as the message text, the three rounds as one
 * `data-board-debate` part — so a reopened thread renders identically to the
 * run that created it.
 */
export function historyToMessages(
  sessions: BoardHistorySession[],
): UIMessage[] {
  return sessions.flatMap((session, index): UIMessage[] => {
    // A session from before the chair shipped has rounds but no conclusion.
    // Replaying it would show an argument that never resolves, so it is dropped
    // rather than rendered as a board that failed to decide.
    const answer = session.answer?.trim();
    if (!answer) return [];

    const debate: BoardDebate = {
      openings: session.personas ?? [],
      objections: session.objections ?? [],
      replies: session.replies ?? [],
    };

    return [
      {
        id: `history-${index}-question`,
        role: "user",
        parts: [{ type: "text", text: session.question }],
      },
      {
        id: `history-${index}-board`,
        role: "assistant",
        parts: [
          // Evidence rides inside the debate now, so no per-persona tool parts:
          // replaying them would put the lookups back above the answer.
          {
            type: "data-board-debate",
            id: `history-${index}-debate`,
            data: debate,
          },
          { type: "text", text: answer },
        ],
      },
    ];
  });
}

export async function fetchBoardHistory(
  baseUrl: string,
  threadId: string,
): Promise<UIMessage[]> {
  try {
    const response = await fetch(`${baseUrl}/board/${threadId}/messages`, {
      cache: "no-store",
    });
    if (!response.ok) return [];

    const { sessions } = (await response.json()) as {
      sessions?: BoardHistorySession[];
    };
    return historyToMessages(sessions ?? []);
  } catch {
    // A board with no reachable history still has to open.
    return [];
  }
}
