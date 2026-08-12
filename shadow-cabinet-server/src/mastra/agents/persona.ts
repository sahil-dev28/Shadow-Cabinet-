import { Agent } from "@mastra/core/agent";
import {
  PromptInjectionDetector,
  TokenLimiterProcessor,
  UnicodeNormalizer,
} from "@mastra/core/processors";
import { Memory } from "@mastra/memory";

import { companyDataTools } from "../tools/company-data-tools.ts";

/**
 * A board turn is roughly 200 words of prose plus tool results. This caps a
 * single persona's output so one runaway answer cannot crowd out the rest of
 * the debate: four agents across two rounds all append to one shared thread,
 * so context growth compounds per round rather than per message.
 */
const OUTPUT_TOKEN_LIMIT = 2000;

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
You have tools that return the company's real figures. Use them. The names
below are the tools exactly as they are registered — call them by these names.
- Never invent, estimate, or recall a number. If you did not fetch it with a
  tool in this conversation, do not state it.
- Call listPeriodsTool first if you are unsure which periods exist.
- Use getMetricTool for any single figure you intend to cite.
- Use compareMetricTool for any quarter-over-quarter claim. Do not do the
  arithmetic yourself.
- Use getSegmentMixTool before blaming or clearing "mix shift".
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
    // Order matters: normalise first so the detector sees the same text the
    // model would, not a version with control characters splitting the words
    // an injection is built from.
    inputProcessors: [
      new UnicodeNormalizer({ stripControlChars: true }),
      // Classification, not reasoning — the cheap fast model is the right tool,
      // and this runs once per agent per round.
      new PromptInjectionDetector({ model: "anthropic/claude-haiku-4-5" }),
    ],
    outputProcessors: [new TokenLimiterProcessor({ limit: OUTPUT_TOKEN_LIMIT })],
    // All four personas share the board thread, so each one sees the whole
    // debate history. Persona distinctness comes from instructions, not
    // from memory isolation.
    memory: new Memory({ options: { lastMessages: 20 } }),
  });
}
