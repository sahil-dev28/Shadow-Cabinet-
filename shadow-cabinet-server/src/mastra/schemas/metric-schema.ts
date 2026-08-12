import { z } from "zod";

/**
 * Shared metric schemas. Tools, seed scripts and any future upload/validation
 * path import from here so the grounding contract is defined in one place.
 */

export const metricQuerySchema = z.object({
  name: z.string().describe('Metric name, e.g. "gross_margin", "revenue", "cac"'),
  period: z.string().describe('Reporting period, e.g. "Q3 2026"'),
});

/** Shape of a document in the `metrics` collection. */
export const metricDocumentSchema = metricQuerySchema.extend({
  value: z.number(),
  unit: z.string(),
  source: z.string(),
});

/** What a metric lookup hands back to an agent. `found: false` is a valid answer. */
export const metricResultSchema = z.object({
  found: z.boolean(),
  value: z.number().nullable(),
  unit: z.string(),
  period: z.string(),
  source: z.string(),
});

export type MetricQuery = z.infer<typeof metricQuerySchema>;
export type MetricDocument = z.infer<typeof metricDocumentSchema>;
export type MetricResult = z.infer<typeof metricResultSchema>;
