import { describe, expect, it } from "vitest";

import { PERSONA_IDS, PERSONAS, boardAgents } from "./index.ts";

describe("the board", () => {
  it("has exactly four personas", () => {
    expect(PERSONA_IDS).toEqual(["cfo", "cmo", "coo", "cso"]);
  });

  it("gives every persona an agent whose id matches its persona id", () => {
    for (const id of PERSONA_IDS) {
      expect(boardAgents[id].id).toBe(`${id}-agent`);
    }
  });

  it("gives every persona a distinct lens", () => {
    const lenses = PERSONA_IDS.map((id) => PERSONAS[id].lens);
    expect(new Set(lenses).size).toBe(PERSONA_IDS.length);
  });

  it("arms every persona with the grounding tools", async () => {
    // `listTools()` is this version's accessor for an agent's configured tools;
    // `Agent` has no `getTools()`, and `getToolsForExecution()` is the
    // execution-time assembler, not the configuration read.
    for (const id of PERSONA_IDS) {
      const tools = await boardAgents[id].listTools();
      expect(Object.keys(tools).sort()).toEqual([
        "compareMetricTool",
        "getMetricTool",
        "getSegmentMixTool",
        "listPeriodsTool",
      ]);
    }
  });

  it("forbids every persona from inventing numbers", async () => {
    for (const id of PERSONA_IDS) {
      const instructions = await boardAgents[id].getInstructions();
      expect(String(instructions)).toMatch(/never invent|never estimate/i);
    }
  });
});
