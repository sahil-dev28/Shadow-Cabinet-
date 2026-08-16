"use client";

import type { BoardDebate, BoardObjection } from "@/lib/debate";
import { PERSONA_TITLES } from "@/lib/personas";
import { useDebateOpen } from "@/lib/use-debate-open";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";

function title(personaId: string) {
  return `${personaId.toUpperCase()} — ${PERSONA_TITLES[personaId] ?? personaId}`;
}

/**
 * A persona that answered "no objection" still sends an entry, so an empty
 * statement is silence rather than a disagreement worth a heading.
 */
function isRealObjection(objection: BoardObjection) {
  return objection.disagrees && objection.statement.trim().length > 0;
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
      {children}
    </h3>
  );
}

export function BoardDebateSection({
  data,
  threadId,
}: {
  data: BoardDebate;
  threadId: string;
}) {
  const [open, choose] = useDebateOpen(threadId);
  const disagreements = data.objections.filter(isRealObjection);

  return (
    <section
      // Ordered last rather than written last: the openings stream while the
      // board is still arguing, so the debate part arrives before the chair's
      // answer exists. Layout, not arrival order, decides what the eye lands on.
      className="order-last my-3 rounded-lg border"
      data-slot="aui_board-debate"
    >
      <button
        type="button"
        onClick={() => choose(!open)}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground w-full px-4 py-2 text-start text-xs font-medium"
      >
        {open ? "Hide the debate" : "Show the debate"}
      </button>

      {open && (
        <div className="space-y-4 px-4 pb-4 text-sm">
          <Heading>Opening positions</Heading>
          {data.openings.map((persona) => (
            <div key={persona.personaId} className="space-y-1">
              <p className="font-medium">{title(persona.personaId)}</p>
              <p className="whitespace-pre-wrap">{persona.text}</p>
              {persona.evidence.length > 0 && (
                <ToolGroupRoot variant="ghost">
                  <ToolGroupTrigger
                    count={persona.evidence.length}
                    label={`Checked ${persona.evidence.length} ${
                      persona.evidence.length === 1 ? "figure" : "figures"
                    }`}
                  />
                  <ToolGroupContent>
                    <ul className="text-muted-foreground list-disc ps-5 text-xs">
                      {persona.evidence.map((call) => (
                        <li key={call.toolCallId}>
                          <code>{call.toolName}</code>{" "}
                          {JSON.stringify(call.input)}
                        </li>
                      ))}
                    </ul>
                  </ToolGroupContent>
                </ToolGroupRoot>
              )}
            </div>
          ))}

          <Heading>Where the board disagreed</Heading>
          {disagreements.length === 0 ? (
            <p className="text-muted-foreground">The board did not disagree.</p>
          ) : (
            disagreements.map((objection) => (
              <div key={objection.personaId} className="space-y-1">
                <p className="font-medium">
                  {objection.personaId.toUpperCase()} →{" "}
                  {objection.with.map((w) => w.toUpperCase()).join(", ")}
                </p>
                <p className="whitespace-pre-wrap">{objection.statement}</p>
              </div>
            ))
          )}

          <Heading>Replies</Heading>
          {data.replies.length === 0 ? (
            <p className="text-muted-foreground">No replies were needed.</p>
          ) : (
            data.replies.map((reply) => (
              <div key={reply.personaId} className="space-y-1">
                <p className="font-medium">
                  {reply.personaId.toUpperCase()} replies
                </p>
                <p className="whitespace-pre-wrap">{reply.text}</p>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
