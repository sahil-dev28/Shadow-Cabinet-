import { MongoClient } from "mongodb";
import type { MetricDocument } from "../schemas/metric-schema";

/**
 * Seeds the metrics collection the get-metric tool reads.
 * Run with: node shadow-cabinet-server/src/mastra/data/seed-metrics.ts
 *
 * Q3 2026 gross margin is 4 points below Q2, which is the scenario the board
 * is built to argue about.
 */
const METRICS: MetricDocument[] = [
  { name: "revenue", period: "Q2 2026", value: 43500, unit: "USD thousands", source: "Q2 2026 P&L" },
  { name: "revenue", period: "Q3 2026", value: 47900, unit: "USD thousands", source: "Q3 2026 P&L" },
  { name: "gross_margin", period: "Q2 2026", value: 62, unit: "percent", source: "Q2 2026 P&L" },
  { name: "gross_margin", period: "Q3 2026", value: 58, unit: "percent", source: "Q3 2026 P&L" },
  { name: "operating_margin", period: "Q2 2026", value: 20.4, unit: "percent", source: "Q2 2026 P&L" },
  { name: "operating_margin", period: "Q3 2026", value: 15.8, unit: "percent", source: "Q3 2026 P&L" },
  { name: "cash", period: "Q3 2026", value: 22600, unit: "USD thousands", source: "Q3 2026 balance sheet" },
  { name: "cac", period: "Q2 2026", value: 57.3, unit: "USD", source: "Q2 2026 KPI pack" },
  { name: "cac", period: "Q3 2026", value: 53.7, unit: "USD", source: "Q3 2026 KPI pack" },
  { name: "ltv", period: "Q3 2026", value: 1090, unit: "USD", source: "Q3 2026 KPI pack" },
  { name: "churn", period: "Q3 2026", value: 3.1, unit: "percent", source: "Q3 2026 KPI pack" },
  { name: "headcount", period: "Q3 2026", value: 383, unit: "people", source: "Q3 2026 HR export" },
];

const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017");
const collection = client
  .db(process.env.MONGODB_DB_NAME ?? "shadow_cabinet")
  .collection("metrics");

await collection.createIndex({ name: 1, period: 1 }, { unique: true });

for (const metric of METRICS) {
  await collection.updateOne(
    { name: metric.name, period: metric.period },
    { $set: metric },
    { upsert: true },
  );
}

console.log(`Seeded ${METRICS.length} metrics.`);
await client.close();
