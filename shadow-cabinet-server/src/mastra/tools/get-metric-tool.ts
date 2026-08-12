import { createTool } from "@mastra/core/tools";
import { MongoClient } from "mongodb";
import {
  metricQuerySchema,
  metricResultSchema,
  type MetricDocument,
} from "../schemas/metric-schema";

const client = new MongoClient(
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
);
const dbName = process.env.MONGODB_DB_NAME ?? "shadow_cabinet";

export const getMetricTool = createTool({
  id: "get-metric",
  description:
    "Fetches a named financial or KPI metric for a given period from the uploaded company data. Use this instead of guessing any number.",
  inputSchema: metricQuerySchema,
  outputSchema: metricResultSchema,
  execute: async ({ name, period }) => {
    const doc = await client
      .db(dbName)
      .collection("metrics")
      .findOne<MetricDocument>({ name, period });

    // A miss is data, not a failure: the agent must be able to say the figure
    // is unavailable rather than fall back on inventing one.
    if (!doc) {
      return {
        found: false,
        value: null,
        unit: "",
        period,
        source: `No "${name}" metric recorded for ${period}.`,
      };
    }

    return {
      found: true,
      value: doc.value,
      unit: doc.unit,
      period: doc.period,
      source: doc.source,
    };
  },
});
