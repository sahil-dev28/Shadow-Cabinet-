import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

export interface PendingRun {
  threadId: string;
  runId: string;
  questions: Array<{ personaId: string; question: string }>;
}

/**
 * A board halted on a question for the CEO. Recorded so the next thing the CEO
 * types resumes that run instead of starting a fresh board, and so the pause
 * survives a server restart.
 */
const COLLECTION = "pending_runs";

const FILE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "pending-runs.json",
);

const uri = process.env.MONGODB_URI;
const client = uri ? new MongoClient(uri) : null;

function collection() {
  return client
    ?.db(process.env.MONGODB_DB_NAME ?? "shadow_cabinet")
    .collection<PendingRun>(COLLECTION);
}

async function readAll(): Promise<PendingRun[]> {
  try {
    return JSON.parse(await readFile(FILE_PATH, "utf8")) as PendingRun[];
  } catch {
    return [];
  }
}

export async function savePendingRun(pending: PendingRun): Promise<void> {
  const store = collection();
  if (store) {
    await store.updateOne(
      { threadId: pending.threadId },
      { $set: pending },
      { upsert: true },
    );
    return;
  }

  const all = (await readAll()).filter((r) => r.threadId !== pending.threadId);
  all.push(pending);
  await writeFile(FILE_PATH, JSON.stringify(all, null, 2), "utf8");
}

export async function getPendingRun(
  threadId: string,
): Promise<PendingRun | null> {
  const store = collection();
  if (store) return store.findOne({ threadId }, { projection: { _id: 0 } });

  return (await readAll()).find((r) => r.threadId === threadId) ?? null;
}

export async function clearPendingRun(threadId: string): Promise<void> {
  const store = collection();
  if (store) {
    await store.deleteOne({ threadId });
    return;
  }

  const all = (await readAll()).filter((r) => r.threadId !== threadId);
  await writeFile(FILE_PATH, JSON.stringify(all, null, 2), "utf8");
}
