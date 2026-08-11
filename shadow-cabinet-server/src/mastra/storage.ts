import { MongoDBStore } from "@mastra/mongodb";

/**
 * Board threads live in the same MongoDB the get-metric tool reads from.
 * Memory needs a storage provider; without one Mastra silently falls back to
 * an in-memory store and every thread dies on restart.
 */
export const storage = new MongoDBStore({
  id: "mastra-storage",
  uri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
  dbName: process.env.MONGODB_DB_NAME ?? "shadow_cabinet",
});
