import { PERSONAS, PERSONA_IDS, type PersonaId } from "../agents/index.ts";

export interface OpeningEntry {
  personaId: PersonaId;
  text: string;
}

export interface RebuttalEntry {
  personaId: PersonaId;
  disagrees: boolean;
  with: PersonaId[];
  statement: string;
}

/** Pass one runs concurrently, so impose a stable order before rendering. */
export function sortByBoardOrder<T extends { personaId: PersonaId }>(
  entries: T[],
): T[] {
  return [...entries].sort(
    (a, b) =>
      PERSONA_IDS.indexOf(a.personaId) - PERSONA_IDS.indexOf(b.personaId),
  );
}

function heading(personaId: PersonaId): string {
  return `### ${personaId.toUpperCase()} — ${PERSONAS[personaId].title}`;
}

export function renderOpeningRound(entries: OpeningEntry[]): string {
  const sections = sortByBoardOrder(entries).map(
    (entry) => `${heading(entry.personaId)}\n\n${entry.text.trim()}`,
  );

  return `## Opening statements\n\n${sections.join("\n\n")}\n`;
}

/**
 * An agent flagged as disagreeing but with nothing to say is treated as
 * agreement. Otherwise an empty section renders under the disagreement
 * heading and reads as a bug.
 */
export function filterDisagreements(entries: RebuttalEntry[]): RebuttalEntry[] {
  return sortByBoardOrder(entries).filter(
    (entry) => entry.disagrees && entry.statement.trim().length > 0,
  );
}

export function renderRebuttalRound(entries: RebuttalEntry[]): string {
  const disagreements = filterDisagreements(entries);

  if (disagreements.length === 0) {
    return "## Where the board disagrees\n\nThe board did not disagree on this question.\n";
  }

  const sections = disagreements.map((entry) => {
    const targets =
      entry.with.length > 0
        ? entry.with.map((id) => id.toUpperCase()).join(", ")
        : "the board";

    return `**${entry.personaId.toUpperCase()} → ${targets}**\n\n${entry.statement.trim()}`;
  });

  return `## Where the board disagrees\n\n${sections.join("\n\n")}\n`;
}

/** The other executives' openings, as one persona will see them in pass two. */
export function formatOpeningsForRebuttal(
  entries: OpeningEntry[],
  excluding: PersonaId,
): string {
  return sortByBoardOrder(entries)
    .filter((entry) => entry.personaId !== excluding)
    .map(
      (entry) =>
        `${entry.personaId.toUpperCase()} (${PERSONAS[entry.personaId].title}):\n${entry.text.trim()}`,
    )
    .join("\n\n");
}

export interface ReplyEntry {
  personaId: PersonaId;
  text: string;
}

/** Only these personas are called in round three. Usually one or two, not four. */
export function personasNamedIn(entries: RebuttalEntry[]): PersonaId[] {
  const named = new Set<PersonaId>();
  for (const entry of filterDisagreements(entries)) {
    for (const target of entry.with) named.add(target);
  }

  return PERSONA_IDS.filter((id) => named.has(id));
}

export function objectionsAimedAt(
  entries: RebuttalEntry[],
  target: PersonaId,
): RebuttalEntry[] {
  return filterDisagreements(entries).filter((entry) =>
    entry.with.includes(target),
  );
}

/**
 * A persona replying sees only what was said about it. Showing the whole
 * round invites it to answer objections aimed at someone else, which is the
 * fourth round this design does not have.
 */
export function formatObjectionsForReply(
  entries: RebuttalEntry[],
  target: PersonaId,
): string {
  return objectionsAimedAt(entries, target)
    .map(
      (entry) =>
        `${entry.personaId.toUpperCase()} (${PERSONAS[entry.personaId].title}) objected:\n${entry.statement.trim()}`,
    )
    .join("\n\n");
}

export function renderReplyRound(entries: ReplyEntry[]): string {
  if (entries.length === 0) {
    return "## Replies\n\nNo replies were needed: nobody was objected to.\n";
  }

  const sections = sortByBoardOrder(entries).map(
    (entry) =>
      `**${entry.personaId.toUpperCase()} replies**\n\n${entry.text.trim()}`,
  );

  return `## Replies\n\n${sections.join("\n\n")}\n`;
}
