"use client";

import type { BoardWaiting } from "@/lib/debate";
import { PERSONA_TITLES } from "@/lib/personas";

function title(personaId: string) {
  return `${personaId.toUpperCase()} — ${PERSONA_TITLES[personaId] ?? personaId}`;
}

/**
 * The board halted mid-debate. Every executive is drawn, not just the ones that
 * spoke: a list of two questions reads as a form to fill in, while the whole
 * board sat around a table reads as what actually happened — four people who
 * have stopped working until the CEO answers.
 */
export function BoardWaitingNotice({ data }: { data: BoardWaiting }) {
  const asked = new Map(data.questions.map((q) => [q.personaId, q.question]));

  return (
    <section
      className="my-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
      data-slot="aui_board-waiting"
    >
      <p className="text-sm font-semibold">The board is waiting on you</p>
      <p className="text-muted-foreground mt-1 text-xs">
        Round one stopped early. Nobody moves on until these are answered.
      </p>

      <ul className="mt-4 space-y-3">
        {Object.keys(PERSONA_TITLES).map((personaId) => {
          const question = asked.get(personaId);

          return (
            <li
              key={personaId}
              // The askers carry the amber rule; the rest sit flush and muted,
              // so the eye lands on the two questions without losing the room.
              className={
                question
                  ? "border-s-2 border-amber-500/60 ps-3"
                  : "ps-3 opacity-70"
              }
            >
              <p
                className={
                  question
                    ? "text-sm font-medium"
                    : "text-muted-foreground text-sm"
                }
              >
                {title(personaId)}
              </p>
              {question ? (
                <p className="mt-1 text-sm whitespace-pre-wrap">{question}</p>
              ) : (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  waiting — no questions
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-muted-foreground mt-4 text-xs">
        Answer below and the board continues from where it stopped.
      </p>
    </section>
  );
}
