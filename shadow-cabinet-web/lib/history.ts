import type { UIMessage } from "ai";

import type { BoardPersonaTurn } from "./board";
import { PERSONA_TITLES, personaHeading } from "./personas";

interface BoardHistorySession {
  question: string;
  personas: BoardPersonaTurn[];
  rebuttalsMarkdown: string;
}

/**
 * Rebuilds past board sessions as UI messages in the same shape the live
 * stream produces, so a reopened thread renders identically to the run that
 * created it — evidence cards included.
 */
export function historyToMessages(
  sessions: BoardHistorySession[],
): UIMessage[] {
  return sessions.flatMap((session, index): UIMessage[] => {
    const parts: UIMessage["parts"] = [];

    for (const persona of session.personas) {
      for (const call of persona.evidence) {
        parts.push({
          type: `tool-${call.toolName}`,
          toolCallId: call.toolCallId,
          state: "output-available",
          input: call.input,
          output: call.output,
        } as UIMessage["parts"][number]);
      }

      parts.push({
        type: "text",
        text: `${personaHeading(persona.personaId)}\n\n${persona.text.trim()}\n`,
      });
    }

    if (session.rebuttalsMarkdown.trim()) {
      parts.push({ type: "text", text: `\n${session.rebuttalsMarkdown}` });
    }

    return [
      {
        id: `history-${index}-question`,
        role: "user",
        parts: [{ type: "text", text: session.question }],
      },
      { id: `history-${index}-board`, role: "assistant", parts },
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

export { PERSONA_TITLES };
