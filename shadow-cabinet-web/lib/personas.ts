export const PERSONA_TITLES: Record<string, string> = {
  cfo: "Chief Financial Officer",
  cmo: "Chief Marketing Officer",
  coo: "Chief Operating Officer",
  cso: "Chief Strategy Officer",
};

export function personaHeading(personaId: string): string {
  return `### ${personaId.toUpperCase()} — ${PERSONA_TITLES[personaId] ?? personaId}`;
}
