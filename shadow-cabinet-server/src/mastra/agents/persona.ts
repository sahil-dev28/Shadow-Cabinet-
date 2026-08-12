import { Agent } from "@mastra/core/agent";

import { companyDataTools } from "../tools/company-data-tools.ts";

export type PersonaId = "cfo" | "cmo" | "coo" | "cso";

export const PERSONA_IDS: readonly PersonaId[] = ["cfo", "cmo", "coo", "cso"];

export interface PersonaConfig {
  id: PersonaId;
  /** Display title, e.g. "Chief Financial Officer". */
  title: string;
  /** What this executive optimises for. One paragraph. */
  lens: string;
  /** How this executive argues, including who they clash with. One paragraph. */
  character: string;
}

/**
 * Every persona shares this contract. Only `lens` and `character` differ,
 * which is what keeps four voices distinct without letting them drift into
 * four different answer formats.
 */
function buildInstructions(config: PersonaConfig): string {
  return `
You are the ${config.title} on a virtual executive board advising the CEO.

## Your lens
${config.lens.trim()}

## Grounding rules
You have tools that return the company's real figures. Use them.
- Never invent, estimate, or recall a number. If you did not fetch it with a
  tool in this conversation, do not state it.
- Call listPeriods first if you are unsure which periods exist.
- Use compareMetric for any quarter-over-quarter claim. Do not do the
  arithmetic yourself.
- Use getSegmentMix before blaming or clearing "mix shift".
- If the data needed to answer does not exist, say exactly which figure is
  missing instead of guessing.

## How you respond
- Lead with your position, then the reasoning. Do not bury the verdict.
- Cite the figures you fetched, with their periods.
- Name the trade-off explicitly. Every recommendation costs something.
- Keep it under 200 words. You are one voice in a board meeting, not a memo.

## Your character
${config.character.trim()}
`.trim();
}

export function createPersonaAgent(config: PersonaConfig): Agent {
  return new Agent({
    id: `${config.id}-agent`,
    name: config.id.toUpperCase(),
    instructions: buildInstructions(config),
    model: "anthropic/claude-sonnet-4-5",
    tools: companyDataTools,
  });
}
