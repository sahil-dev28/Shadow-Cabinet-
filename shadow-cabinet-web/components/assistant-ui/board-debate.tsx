"use client";

import type { BoardDebate, BoardObjection, BoardPhase } from "@/lib/debate";
import { PERSONA_IDS, PERSONA_TITLES } from "@/lib/personas";
import { useDebateOpen } from "@/lib/use-debate-open";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { cn } from "@/lib/utils";

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

/**
 * The board sits in a fixed order, so the feed reads the same way every round —
 * the CFO's objection lands where the CFO's opening was, not wherever the model
 * happened to finish first.
 */
function boardOrder(personaId: string) {
  const seat = (PERSONA_IDS as readonly string[]).indexOf(personaId);
  return seat === -1 ? PERSONA_IDS.length : seat;
}

function inBoardOrder<T extends { personaId: string }>(turns: T[]): T[] {
  return [...turns].sort((a, b) => boardOrder(a.personaId) - boardOrder(b.personaId));
}

/**
 * How many rounds have landed. A halted board has only its openings, and both
 * `complete` and `replies` have all three — the difference between those two is
 * whether anything is still working, which `inFlight` answers.
 */
const LANDED: Record<BoardPhase, number> = {
  openings: 1,
  paused: 1,
  objections: 2,
  replies: 3,
  complete: 3,
};

/** What the board is doing right now, or nothing when it has stopped. */
function inFlight(phase: BoardPhase): string | null {
  switch (phase) {
    case "openings":
      return "Weighing each other's positions";
    case "objections":
      return "Answering the objections";
    case "replies":
      return "Writing the chair's answer";
    default:
      return null;
  }
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
      {children}
    </h3>
  );
}

/**
 * The round in flight, drawn with the same shimmer the thread uses while the
 * board is convening, so a section that is about to fill in never looks like a
 * section that came back empty.
 */
function Working({ label }: { label: string }) {
  return (
    <ToolGroupRoot variant="ghost" aria-label={label}>
      <ToolGroupTrigger count={0} label={label} active />
    </ToolGroupRoot>
  );
}

function Turn({
  heading,
  body,
  fresh,
  children,
}: {
  heading: string;
  body: string;
  /** Rows that arrived while the CEO was watching; a stored thread has none. */
  fresh: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "space-y-1",
        fresh && "animate-in fade-in slide-in-from-top-1 duration-300 motion-reduce:animate-none",
      )}
    >
      <p className="font-medium">{heading}</p>
      <p className="whitespace-pre-wrap">{body}</p>
      {children}
    </div>
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

  const { phase } = data;
  const landed = LANDED[phase];
  const working = inFlight(phase);
  // A stored thread rehydrates whole, so nothing there should slide in.
  const fresh = phase !== "complete";

  const disagreements = inBoardOrder(data.objections.filter(isRealObjection));

  return (
    <section
      // Ordered last rather than written last: the openings stream while the
      // board is still arguing, so the debate part arrives before the chair's
      // answer exists. Layout, not arrival order, decides what the eye lands on.
      className="order-last my-3 rounded-lg border"
      data-slot="aui_board-debate"
      data-phase={phase}
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
        // `aria-live`, not a spinner a screen reader has to notice: the section
        // grows a round at a time while the CEO is reading the one before it.
        <div className="space-y-4 px-4 pb-4 text-sm" aria-live="polite">
          <Heading>Opening positions</Heading>
          {inBoardOrder(data.openings).map((persona) => (
            <Turn
              key={persona.personaId}
              heading={title(persona.personaId)}
              body={persona.text}
              fresh={fresh}
            >
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
            </Turn>
          ))}

          {/* A round the board has not reached gets no heading at all: an
              empty "Replies" would read as a round that produced nothing.
              Fragments, not wrappers, so `space-y-4` still sees the rows. */}
          {landed >= 2 && (
            <>
              <Heading>Where the board disagreed</Heading>
              {disagreements.length === 0 ? (
                <p className="text-muted-foreground">
                  The board did not disagree.
                </p>
              ) : (
                disagreements.map((objection) => (
                  <Turn
                    key={objection.personaId}
                    heading={`${objection.personaId.toUpperCase()} → ${objection.with
                      .map((w) => w.toUpperCase())
                      .join(", ")}`}
                    body={objection.statement}
                    fresh={fresh}
                  />
                ))
              )}
            </>
          )}

          {landed >= 3 && (
            <>
              <Heading>Replies</Heading>
              {data.replies.length === 0 ? (
                <p className="text-muted-foreground">No replies were needed.</p>
              ) : (
                inBoardOrder(data.replies).map((reply) => (
                  <Turn
                    key={reply.personaId}
                    heading={`${reply.personaId.toUpperCase()} replies`}
                    body={reply.text}
                    fresh={fresh}
                  />
                ))
              )}
            </>
          )}

          {working && <Working label={working} />}
        </div>
      )}
    </section>
  );
}
