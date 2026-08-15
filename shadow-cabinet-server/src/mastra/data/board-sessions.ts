import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

export interface BoardEvidence {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
}

export interface BoardPersonaTurn {
  personaId: string;
  text: string;
  evidence: BoardEvidence[];
}

/** One executive's objection, as round two recorded it. */
export interface BoardObjection {
  personaId: string;
  disagrees: boolean;
  with: string[];
  statement: string;
}

export interface BoardReply {
  personaId: string;
  text: string;
}

/**
 * A thread is never all three at once, so it is derived on read rather than
 * written as a fourth record that could disagree with the other three.
 */
export type ThreadStatus = "running" | "waiting_on_ceo" | "resolved";

/**
 * The three rounds are stored structured rather than as rendered markdown: the
 * renderer decides how a round looks, and a second markdown copy alongside the
 * structure only gives the two something to disagree about.
 */
export interface BoardSession {
  threadId: string;
  question: string;
  answer: string;
  personas: BoardPersonaTurn[];
  objections: BoardObjection[];
  replies: BoardReply[];
  createdAt: string;
}

/**
 * The board as the CEO saw it. The agent thread cannot serve this: it stores
 * every internal prompt as a user turn, so replaying it would show the question
 * four times and the rebuttal scaffolding in between.
 */
const COLLECTION = "board_sessions";

const FILE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "board-sessions.json",
);

const uri = process.env.MONGODB_URI;
const client = uri ? new MongoClient(uri) : null;

function collection() {
  return client
    ?.db(process.env.MONGODB_DB_NAME ?? "shadow_cabinet")
    .collection<BoardSession>(COLLECTION);
}

async function readFileSessions(): Promise<BoardSession[]> {
  try {
    return JSON.parse(await readFile(FILE_PATH, "utf8")) as BoardSession[];
  } catch {
    return [];
  }
}

export async function saveBoardSession(
  session: Omit<BoardSession, "createdAt"> & { createdAt?: string },
): Promise<void> {
  const record: BoardSession = {
    ...session,
    createdAt: session.createdAt ?? new Date().toISOString(),
  };

  const store = collection();
  if (store) {
    await store.insertOne(record);
    return;
  }

  const all = await readFileSessions();
  all.push(record);
  await writeFile(FILE_PATH, JSON.stringify(all, null, 2), "utf8");
}

/** Every session on one thread, oldest first, so the UI replays in order. */
export async function listBoardSessions(
  threadId: string,
): Promise<BoardSession[]> {
  const store = collection();
  if (store) {
    return store.find({ threadId }).sort({ createdAt: 1 }).toArray();
  }

  return (await readFileSessions())
    .filter((session) => session.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
