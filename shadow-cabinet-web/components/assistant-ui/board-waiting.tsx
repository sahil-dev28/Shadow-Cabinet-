"use client";

import type { BoardWaiting } from "@/lib/debate";

/**
 * Placeholder. The real waiting screen — all four personas visible and visibly
 * paused, the ones that asked highlighted — is Task 8's job; this exists so the
 * debate renderer can be registered alongside it without a missing import.
 */
export function BoardWaitingNotice({ data }: { data: BoardWaiting }) {
  return (
    <section className="my-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-semibold">The board is waiting on you</p>
      <ul className="mt-3 space-y-2">
        {data.questions.map((question) => (
          <li key={question.personaId} className="text-sm">
            <span className="font-medium">
              {question.personaId.toUpperCase()}
            </span>{" "}
            {question.question}
          </li>
        ))}
      </ul>
    </section>
  );
}
