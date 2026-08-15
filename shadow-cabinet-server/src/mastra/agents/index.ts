import type { Agent } from "@mastra/core/agent";

import { cfoAgent, cfoPersona } from "./cfo-agent.ts";
import { cmoAgent, cmoPersona } from "./cmo-agent.ts";
import { cooAgent, cooPersona } from "./coo-agent.ts";
import { csoAgent, csoPersona } from "./cso-agent.ts";
import type { PersonaConfig, PersonaId } from "./persona.ts";

export { PERSONA_IDS } from "./persona.ts";
export type { PersonaConfig, PersonaId } from "./persona.ts";
export { cfoAgent, cmoAgent, cooAgent, csoAgent };
// Deliberately absent from PERSONAS, PERSONA_IDS and boardAgents below: those
// drive the debate fan-outs, and a chair fanned out to is a fifth debater.
export { chairAgent } from "./chair.ts";

export const PERSONAS: Record<PersonaId, PersonaConfig> = {
  cfo: cfoPersona,
  cmo: cmoPersona,
  coo: cooPersona,
  cso: csoPersona,
};

export const boardAgents: Record<PersonaId, Agent> = {
  cfo: cfoAgent,
  cmo: cmoAgent,
  coo: cooAgent,
  cso: csoAgent,
};
