"use client";

import type { UIMessage } from "ai";
import { useRef } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { BoardTargetProvider, useBoardTarget } from "@/lib/board-target";
import { Thread } from "@/components/assistant-ui/thread";
import { BoardDataUI } from "@/components/assistant-ui/board-data-ui";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export const Assistant = ({
  threadId,
  initialMessages = [],
}: {
  threadId: string;
  initialMessages?: UIMessage[];
}) => (
  // Outside the workspace rather than inside it: the workspace reads the target
  // to build the transport, and a component cannot consume its own provider.
  <BoardTargetProvider>
    <BoardWorkspace threadId={threadId} initialMessages={initialMessages} />
  </BoardTargetProvider>
);

const BoardWorkspace = ({
  threadId,
  initialMessages,
}: {
  threadId: string;
  initialMessages: UIMessage[];
}) => {
  const { target } = useBoardTarget();
  // The runtime holds on to one transport, so a `body` closed over `target`
  // would keep posting whichever executive was selected first. Reading through
  // a ref survives that: its identity never changes, its contents do.
  const targetRef = useRef(target);
  targetRef.current = target;

  const runtime = useChatRuntime({
    messages: initialMessages,
    // No `sendAutomaticallyWhen`: tools run server-side, so a reply carrying
    // finished tool calls is the final answer. Auto-sending on complete tool
    // calls would fire a fresh board session after every response, forever.
    transport: new AssistantChatTransport({
      api: "/api/chat",
      // A function, not an object: `body` is resolved per send, which is the
      // only reason the selector can still change the target mid-thread.
      body: () => ({ threadId, target: targetRef.current }),
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <BoardDataUI threadId={threadId} />
      <SidebarProvider>
        <div className="flex h-dvh w-full pr-0.5">
          <ThreadListSidebar />
          <SidebarInset>
            <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger />
              <Separator orientation="vertical" className="mr-2 h-4" />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem className="hidden md:block">
                    <BreadcrumbLink href="/">Board</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{threadId.replace(/^board-/, "Session ").slice(0, 20)}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </header>
            <div className="flex-1 overflow-hidden">
              <Thread />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </AssistantRuntimeProvider>
  );
};
