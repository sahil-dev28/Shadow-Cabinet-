/**
 * The shapes the board speaks in, shared by the proxy that streams a live run,
 * the component that draws it, and the rehydration that replays a stored one.
 *
 * They live apart from `board.ts` so a renderer can name what it is drawing
 * without importing the polling client that fetched it.
 */

export interface BoardEvidence {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
}

/** Round one: one executive's position and the figures it fetched to hold it. */
export interface BoardPersonaTurn {
  personaId: string;
  text: string;
  evidence: BoardEvidence[];
}

/** Round two: who disagreed, with whom, and on what. */
export interface BoardObjection {
  personaId: string;
  disagrees: boolean;
  with: string[];
  statement: string;
}

/** Round three: an objected-to executive's last word. */
export interface BoardReply {
  personaId: string;
  text: string;
}

/**
 * All three rounds as one unit. Streamed as a single `data-board-debate` part
 * rather than as prose so the argument stays underneath the chair's answer and
 * folds away, instead of burying it.
 */
export interface BoardDebate {
  openings: BoardPersonaTurn[];
  objections: BoardObjection[];
  replies: BoardReply[];
}

export interface CeoQuestion {
  personaId: string;
  question: string;
}

/** The board halted: what it needs from the CEO before it can carry on. */
export interface BoardWaiting {
  questions: CeoQuestion[];
}
