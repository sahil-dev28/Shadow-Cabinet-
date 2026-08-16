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

/** One row per thread that has ever produced an answer. */
export interface BoardThreadSummary {
  threadId: string;
  /** The question that opened the thread — its label until it is titled. */
  firstQuestion: string;
  /** When the thread last produced an answer, so the sidebar can order by it. */
  updatedAt: string;
}

/**
 * Every thread the board has answered on, newest first. `listBoardSessions`
 * cannot serve the sidebar: it answers "what happened on this thread", and the
 * sidebar needs "which threads are there" before it knows any id to ask about.
 */
export async function listBoardThreads(): Promise<BoardThreadSummary[]> {
  const store = collection();
  const sessions = store
    ? await store.find({}).sort({ createdAt: 1 }).toArray()
    : (await readFileSessions()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );

  // Oldest first above, so the first session seen for a thread is the one that
  // opened it and every later one only moves `updatedAt` forward.
  const threads = new Map<string, BoardThreadSummary>();
  for (const session of sessions) {
    const seen = threads.get(session.threadId);
    if (seen) {
      seen.updatedAt = session.createdAt;
      continue;
    }

    threads.set(session.threadId, {
      threadId: session.threadId,
      firstQuestion: session.question,
      updatedAt: session.createdAt,
    });
  }

  return [...threads.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}
