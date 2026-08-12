import { redirect } from "next/navigation";

import { newThreadId } from "@/lib/thread";

export default function Home() {
  // A fresh board session gets its own URL so it can be returned to.
  redirect(`/board/${newThreadId()}`);
}
