export const PERSONA_IDS = ["cfo", "cmo", "coo", "cso"] as const;

export type PersonaId = (typeof PERSONA_IDS)[number];

/** Who the composer is addressing: the whole board, or one executive alone. */
export type BoardTarget = "board" | PersonaId;

export const PERSONA_TITLES: Record<string, string> = {
  cfo: "Chief Financial Officer",
  cmo: "Chief Marketing Officer",
  coo: "Chief Operating Officer",
  cso: "Chief Strategy Officer",
};

/**
 * The target arrives from the browser and ends up inside an upstream URL, so it
 * is matched against the roster rather than trusted.
 */
export function isPersonaId(value: unknown): value is PersonaId {
  return (
    typeof value === "string" &&
    (PERSONA_IDS as readonly string[]).includes(value)
  );
}

export function personaHeading(personaId: string): string {
  return `### ${personaId.toUpperCase()} — ${PERSONA_TITLES[personaId] ?? personaId}`;
}
