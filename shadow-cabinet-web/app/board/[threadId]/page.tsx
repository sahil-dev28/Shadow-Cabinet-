import { Assistant } from "@/app/assistant";
import { fetchBoardHistory } from "@/lib/history";

const MASTRA_API_URL = process.env.MASTRA_API_URL ?? "http://localhost:4111";

export default async function BoardPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const { messages } = await fetchBoardHistory(MASTRA_API_URL, threadId);

  return <Assistant threadId={threadId} initialMessages={messages} />;
}
