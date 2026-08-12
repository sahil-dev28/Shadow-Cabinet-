import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import {
  METRIC_NAMES,
  compareMetric,
  getMetric,
  getSegmentMix,
  listPeriods,
} from "../data/company-data.ts";
import { getCompanyData } from "../data/company-data-provider.ts";

const metricSchema = z
  .enum(METRIC_NAMES)
  .describe("The metric to look up. Must be one of the listed names.");

const periodSchema = z
  .string()
  .describe('A fiscal period such as "2025-Q3". Call listPeriods first if unsure.');

/** Percentage metrics are already percentages; everything else is a raw figure. */
function unitFor(metric: string): string {
  if (metric.endsWith("Pct")) return "percent";
  if (metric === "headcount" || metric === "newCustomers") return "count";
  return "USD thousands";
}

/** Turns a thrown Error into data the model can read and correct itself with. */
function asError(error: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export const listPeriodsTool = createTool({
  id: "list-periods",
  description:
    "List every fiscal period for which company figures exist. Call this before any other data tool if you are unsure which periods are available.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(),
    periods: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const data = await getCompanyData();
      return { ok: true as const, periods: listPeriods(data) };
    } catch (error) {
      return asError(error);
    }
  },
});

export const getMetricTool = createTool({
  id: "get-metric",
  description:
    "Get one company metric for one period. Use this whenever you need to cite a figure. Never estimate a number you have not looked up.",
  inputSchema: z.object({ metric: metricSchema, period: periodSchema }),
  outputSchema: z.object({
    ok: z.boolean(),
    metric: z.string().optional(),
    period: z.string().optional(),
    value: z.number().optional(),
    unit: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ metric, period }) => {
    try {
      const data = await getCompanyData();
      const result = getMetric(data, metric, period);
      return { ok: true as const, ...result, unit: unitFor(result.metric) };
    } catch (error) {
      return asError(error);
    }
  },
});

export const compareMetricTool = createTool({
  id: "compare-metric",
  description:
    "Compare one metric across two periods and get the absolute and percentage change. Use this for any quarter-over-quarter claim instead of doing the arithmetic yourself.",
  inputSchema: z.object({
    metric: metricSchema,
    fromPeriod: periodSchema,
    toPeriod: periodSchema,
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    metric: z.string().optional(),
    from: z.object({ period: z.string(), value: z.number() }).optional(),
    to: z.object({ period: z.string(), value: z.number() }).optional(),
    delta: z.number().optional(),
    deltaPct: z.number().optional(),
    unit: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ metric, fromPeriod, toPeriod }) => {
    try {
      const data = await getCompanyData();
      const result = compareMetric(data, metric, fromPeriod, toPeriod);
      return { ok: true as const, ...result, unit: unitFor(result.metric) };
    } catch (error) {
      return asError(error);
    }
  },
});

export const getSegmentMixTool = createTool({
  id: "get-segment-mix",
  description:
    "Get revenue and gross margin split by business segment for one period, including each segment's share of total revenue. Use this to test whether a margin change came from mix shift.",
  inputSchema: z.object({ period: periodSchema }),
  outputSchema: z.object({
    ok: z.boolean(),
    period: z.string().optional(),
    totalRevenue: z.number().optional(),
    segments: z
      .array(
        z.object({
          name: z.string(),
          revenue: z.number(),
          revenueSharePct: z.number(),
          grossMarginPct: z.number(),
        }),
      )
      .optional(),
    error: z.string().optional(),
  }),
  execute: async ({ period }) => {
    try {
      const data = await getCompanyData();
      return { ok: true as const, ...getSegmentMix(data, period) };
    } catch (error) {
      return asError(error);
    }
  },
});

export const companyDataTools = {
  listPeriodsTool,
  getMetricTool,
  compareMetricTool,
  getSegmentMixTool,
};
