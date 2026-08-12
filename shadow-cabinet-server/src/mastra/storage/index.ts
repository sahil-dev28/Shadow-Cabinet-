import { LibSQLStore } from "@mastra/libsql";
import { MongoDBStore } from "@mastra/mongodb";

/**
 * MongoDB is the intended store. LibSQL is the zero-setup fallback so a
 * reviewer without a local Mongo can still run the prototype. Nothing else
 * in the system depends on which one is active.
 */
export function createStorage() {
  const uri = process.env.MONGODB_URI;

  if (uri) {
    return new MongoDBStore({
      id: "mastra-storage",
      uri,
      dbName: process.env.MONGODB_DB_NAME ?? "shadow_cabinet",
    });
  }

  return new LibSQLStore({
    id: "mastra-storage",
    url: "file:./shadow-cabinet.db",
  });
}
