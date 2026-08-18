import type { UIMessage } from "ai";

import type {
  BoardDebate,
  BoardObjection,
  BoardPersonaTurn,
  BoardReply,
  CeoQuestion,
} from "./debate";

/**
 * `running` is the catch-all the history route falls back to, so an unknown
 * thread id reads as a board in progress rather than as an error.
 */
export type ThreadStatus = "running" | "waiting_on_ceo" | "resolved";

export interface BoardHistory {
  messages: UIMessage[];
  status: ThreadStatus;
}

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
      // Nothing is in flight in a stored session, so it rehydrates into the
      // settled state rather than into a round that will never finish.
      phase: "complete",
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
): Promise<BoardHistory> {
  try {
    const response = await fetch(`${baseUrl}/board/${threadId}/messages`, {
      cache: "no-store",
    });
    if (!response.ok) return { messages: [], status: "running" };

    const { sessions, pending, status } = (await response.json()) as {
      sessions?: BoardHistorySession[];
      pending?: { questions: CeoQuestion[] } | null;
      status?: ThreadStatus;
    };

    const messages = historyToMessages(sessions ?? []);

    // A thread stopped mid-question reopens into the room that is waiting,
    // rather than into an empty composer that gives the CEO nothing to answer.
    // Keyed off `waiting_on_ceo` and never off "not resolved": `running` covers
    // both a live board and a thread id that never existed.
    if (status === "waiting_on_ceo" && pending) {
      messages.push({
        id: "history-waiting",
        role: "assistant",
        parts: [
          // The prefixed wire shape: `UIMessage` parts carry `data-`, and only
          // the runtime part the renderer is registered for drops it.
          {
            type: "data-board-waiting",
            id: "board-waiting",
            data: { questions: pending.questions },
          },
        ],
      });
    }

    return { messages, status: status ?? "running" };
  } catch {
    // A board with no reachable history still has to open.
    return { messages: [], status: "running" };
  }
}
