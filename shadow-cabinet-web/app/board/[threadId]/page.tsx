import { Assistant } from "@/app/assistant";

export default async function BoardPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;

  return <Assistant threadId={threadId} />;
}
