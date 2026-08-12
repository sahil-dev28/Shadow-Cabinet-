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
