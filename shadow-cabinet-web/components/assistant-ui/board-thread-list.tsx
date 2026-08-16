"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface BoardThread {
  threadId: string;
  title: string;
  updatedAt: string;
}

/**
 * The sidebar's list of past boards.
 *
 * Deliberately not assistant-ui's `ThreadList`, which is bound to the runtime's
 * own in-memory thread list. A board here is a URL backed by a Mastra thread
 * that outlives the page, so the runtime has never known about any of them and
 * the list it renders can only ever say "New Chat".
 */
export const BoardThreadList: FC = () => {
  const pathname = usePathname();
  const [threads, setThreads] = useState<BoardThread[] | null>(null);

  // Keyed on the pathname so opening a board refetches: the one that just
  // answered is not in a list fetched before it ran.
  useEffect(() => {
    let current = true;

    fetch("/api/threads")
      .then((response) => response.json())
      .then((body: { threads?: BoardThread[] }) => {
        if (current) setThreads(body.threads ?? []);
      })
      .catch(() => {
        if (current) setThreads([]);
      });

    return () => {
      current = false;
    };
  }, [pathname]);

  return (
    <div
      data-slot="aui_board-thread-list"
      className="flex flex-col gap-0.5"
    >
      <Button
        variant="ghost"
        // `/` redirects to a fresh board id, so the button needs no id of its own.
        render={<Link href="/" />}
        // It renders an anchor, not a `<button>`; Base UI warns unless told so.
        nativeButton={false}
        className="hover:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal"
      >
        <PlusIcon className="size-4 shrink-0" />
        <span className="whitespace-nowrap">New Thread</span>
      </Button>

      {threads === null ? (
        <BoardThreadListSkeleton />
      ) : threads.length === 0 ? (
        <p className="text-muted-foreground px-2.5 py-4 text-sm">
          No past boards yet.
        </p>
      ) : (
        threads.map((thread) => {
          const active = pathname === `/board/${thread.threadId}`;

          return (
            <Link
              key={thread.threadId}
              href={`/board/${thread.threadId}`}
              aria-current={active ? "page" : undefined}
              title={thread.title}
              data-slot="aui_board-thread-list-item"
              className={cn(
                "hover:bg-muted focus-visible:ring-ring/50 flex h-8 items-center rounded-md px-2.5 text-sm outline-none focus-visible:ring-[3px]",
                active && "bg-muted",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            </Link>
          );
        })
      )}
    </div>
  );
};

const BoardThreadListSkeleton: FC = () => (
  <div className="flex flex-col gap-0.5">
    {Array.from({ length: 5 }, (_, index) => (
      <div
        key={index}
        role="status"
        aria-label="Loading boards"
        className="flex h-8 items-center px-2.5"
      >
        <Skeleton className="h-3.5 w-full" />
      </div>
    ))}
  </div>
);
