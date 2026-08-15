import { describe, expect, it } from "vitest";

import { chairAgent } from "./chair.ts";

describe("the chair", () => {
  it("is not a board persona", () => {
    expect(chairAgent.id).toBe("chair-agent");
  });

  it("has the same grounding tools as the board", async () => {
    const tools = await chairAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      "compareMetricTool",
      "getMetricTool",
      "getSegmentMixTool",
      "listPeriodsTool",
    ]);
  });

  it("is told to commit to a recommendation and never to ask the CEO a question", async () => {
    const instructions = String(await chairAgent.getInstructions());
    expect(instructions).toMatch(/never ask the ceo/i);
    expect(instructions).toMatch(/flip/i);
    expect(instructions).toMatch(/never invent|never estimate/i);
  });
});
