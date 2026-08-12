import { describe, expect, it } from "vitest";

import companyDataJson from "./company-data.json" with { type: "json" };
import {
  type CompanyData,
  compareMetric,
  getMetric,
  getSegmentMix,
  listPeriods,
} from "./company-data.ts";

const data = companyDataJson as CompanyData;

describe("listPeriods", () => {
  it("returns every period in chronological order", () => {
    expect(listPeriods(data)).toEqual([
      "2024-Q4",
      "2025-Q1",
      "2025-Q2",
      "2025-Q3",
    ]);
  });
});

describe("getMetric", () => {
  it("returns the value for a known metric and period", () => {
    expect(getMetric(data, "grossMarginPct", "2025-Q3")).toEqual({
      metric: "grossMarginPct",
      period: "2025-Q3",
      value: 58,
    });
  });

  it("lists the valid periods when the period is unknown", () => {
    expect(() => getMetric(data, "revenue", "2026-Q1")).toThrow(/2025-Q3/);
  });

  it("lists the valid metrics when the metric is unknown", () => {
    // @ts-expect-error -- deliberately passing an invalid metric name
    expect(() => getMetric(data, "ebitda", "2025-Q3")).toThrow(/grossMarginPct/);
  });
});

describe("compareMetric", () => {
  it("computes the absolute and percentage delta between two periods", () => {
    const result = compareMetric(data, "grossMarginPct", "2025-Q2", "2025-Q3");

    expect(result.from).toEqual({ period: "2025-Q2", value: 62 });
    expect(result.to).toEqual({ period: "2025-Q3", value: 58 });
    expect(result.delta).toBe(-4);
    expect(result.deltaPct).toBeCloseTo(-6.45, 2);
  });

  it("reports a zero delta when nothing changed", () => {
    const result = compareMetric(data, "grossMarginPct", "2025-Q1", "2025-Q2");

    expect(result.delta).toBe(0);
    expect(result.deltaPct).toBe(0);
  });
});

describe("getSegmentMix", () => {
  it("returns each segment's revenue share of the period", () => {
    const result = getSegmentMix(data, "2025-Q3");

    expect(result.totalRevenue).toBe(47900);

    const freight = result.segments.find(
      (segment) => segment.name === "Freight Brokerage",
    );
    expect(freight?.revenueSharePct).toBeCloseTo(39.0, 1);
    expect(freight?.grossMarginPct).toBe(41);
  });

  it("shows the mix shift that explains the Q3 margin drop", () => {
    const q2 = getSegmentMix(data, "2025-Q2");
    const q3 = getSegmentMix(data, "2025-Q3");

    const shareOf = (mix: typeof q2, name: string) =>
      mix.segments.find((segment) => segment.name === name)!.revenueSharePct;

    expect(shareOf(q2, "Freight Brokerage")).toBeCloseTo(25.0, 1);
    expect(shareOf(q3, "Freight Brokerage")).toBeCloseTo(39.0, 1);
  });
});
