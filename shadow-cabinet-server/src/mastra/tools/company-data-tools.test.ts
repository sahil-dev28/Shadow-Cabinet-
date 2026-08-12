import { describe, expect, it } from "vitest";

import {
  compareMetricTool,
  getMetricTool,
  getSegmentMixTool,
  listPeriodsTool,
} from "./company-data-tools.ts";

/**
 * `Tool.execute` is optional on the type and takes an execution context these
 * tools never read. This calls it the way Mastra does at runtime, and narrows
 * the result away from the `void | ValidationError` half of the union.
 */
async function run<T>(
  tool: { execute?: (input: never, context: never) => Promise<unknown> },
  input: unknown,
): Promise<T> {
  return (await tool.execute!(input as never, {} as never)) as T;
}

describe("listPeriodsTool", () => {
  it("returns every available period", async () => {
    const result = await run(listPeriodsTool, {});

    expect(result).toEqual({
      ok: true,
      periods: ["2024-Q4", "2025-Q1", "2025-Q2", "2025-Q3"],
    });
  });
});

describe("getMetricTool", () => {
  it("returns a single grounded value", async () => {
    const result = await run(getMetricTool, {
      metric: "grossMarginPct",
      period: "2025-Q3",
    });

    expect(result).toEqual({
      ok: true,
      metric: "grossMarginPct",
      period: "2025-Q3",
      value: 58,
      unit: "percent",
    });
  });

  it("returns a correctable error instead of throwing on a bad period", async () => {
    const result = await run<{ ok: boolean; error?: string }>(getMetricTool, {
      metric: "revenue",
      period: "2026-Q1",
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("error", expect.stringContaining("2025-Q3"));
  });
});

describe("compareMetricTool", () => {
  it("returns both endpoints and the delta", async () => {
    const result = await run(compareMetricTool, {
      metric: "grossMarginPct",
      fromPeriod: "2025-Q2",
      toPeriod: "2025-Q3",
    });

    expect(result).toMatchObject({
      ok: true,
      delta: -4,
      from: { period: "2025-Q2", value: 62 },
      to: { period: "2025-Q3", value: 58 },
    });
  });
});

describe("getSegmentMixTool", () => {
  it("returns each segment's share of revenue", async () => {
    const result = await run(getSegmentMixTool, { period: "2025-Q3" });

    expect(result).toMatchObject({ ok: true, totalRevenue: 47900 });
  });
});
