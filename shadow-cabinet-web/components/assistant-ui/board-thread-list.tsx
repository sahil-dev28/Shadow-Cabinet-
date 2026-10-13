"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  EyeOffIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type BoardThread,
  groupThreads,
  isUnread,
} from "@/lib/board-threads";
import { cn } from "@/lib/utils";

/** The subset of a row the sidebar can change without asking the server first. */
type ThreadPatch = Partial<Pick<BoardThread, "title" | "pinned" | "readAt">>;

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
  const router = useRouter();
  const [threads, setThreads] = useState<BoardThread[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BoardThread | null>(null);

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

  /**
   * Writes a change to the row and sends it behind that.
   *
   * Optimistic on purpose: a pin that waits on a round trip reads as broken.
   * The pre-change row is captured so a failed request can put it back rather
   * than leaving the sidebar claiming something the server never accepted.
   */
  const patchThread = useCallback(
    async (threadId: string, patch: ThreadPatch) => {
      let restore: BoardThread | undefined;

      setThreads((current) => {
        if (!current) return current;

        return current.map((thread) => {
          if (thread.threadId !== threadId) return thread;
          restore = thread;

          return { ...thread, ...patch };
        });
      });

      try {
        const response = await fetch(`/api/threads/${threadId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error(String(response.status));
      } catch {
        setThreads((current) => {
          if (!current || !restore) return current;
          const previous = restore;

          return current.map((thread) =>
            thread.threadId === threadId ? previous : thread,
          );
        });
      }
    },
    [],
  );

  const openThreadId = pathname.startsWith("/board/")
    ? pathname.slice("/board/".length)
    : null;

  // Opening a board reads it. Run from the sidebar rather than from the page:
  // this is mounted on every board route, so there is one place that has to
  // remember to do it instead of one per page that might not.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!threads || !openThreadId) return;
    if (markedRef.current === openThreadId) return;

    const open = threads.find((thread) => thread.threadId === openThreadId);
    if (!open) return;

    // Claimed before the unread check rather than after it. A board that was
    // already read still counts as seen, and leaving the claim unset would arm
    // this to fire again the moment something made the row unread — which is
    // exactly what "mark as unread" on the open board does, so it would undo
    // itself instantly.
    markedRef.current = openThreadId;
    if (!isUnread(open)) return;

    void patchThread(openThreadId, { readAt: new Date().toISOString() });
  }, [threads, openThreadId, patchThread]);

  const deleteThread = async (thread: BoardThread) => {
    setThreads((current) =>
      current?.filter((row) => row.threadId !== thread.threadId) ?? current,
    );

    await fetch(`/api/threads/${thread.threadId}`, { method: "DELETE" }).catch(
      () => undefined,
    );

    // Deleting the board you are reading leaves the page showing a thread that
    // no longer exists, so it moves to `/` — which redirects to a fresh id.
    if (openThreadId === thread.threadId) router.push("/");
  };

  const groups = useMemo(() => groupThreads(threads ?? []), [threads]);

  return (
    <div data-slot="aui_board-thread-list" className="flex flex-col gap-0.5">
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
        groups.map((group) => (
          <Fragment key={group.label ?? "all"}>
            {group.label && (
              <div
                data-slot="aui_board-thread-list-group-label"
                className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium"
              >
                {group.label}
              </div>
            )}
            {group.threads.map((thread) => (
              <BoardThreadRow
                key={thread.threadId}
                thread={thread}
                active={pathname === `/board/${thread.threadId}`}
                renaming={renamingId === thread.threadId}
                onRenameStart={() => setRenamingId(thread.threadId)}
                onRenameEnd={() => setRenamingId(null)}
                onPatch={(patch) => patchThread(thread.threadId, patch)}
                onDelete={() => setPendingDelete(thread)}
              />
            ))}
          </Fragment>
        ))
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this board?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.title}” and everything the board said on it will
              be removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) void deleteThread(pendingDelete);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const BoardThreadRow: FC<{
  thread: BoardThread;
  active: boolean;
  renaming: boolean;
  onRenameStart: () => void;
  onRenameEnd: () => void;
  onPatch: (patch: ThreadPatch) => void;
  onDelete: () => void;
}> = ({
  thread,
  active,
  renaming,
  onRenameStart,
  onRenameEnd,
  onPatch,
  onDelete,
}) => {
  const unread = isUnread(thread);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  // Leaving the rename input focuses nothing, so a keyboard user is dropped at
  // the top of the document. Focus goes back to the menu button they came from.
  useEffect(() => {
    if (renaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [renaming]);

  return (
    <div
      data-slot="aui_board-thread-list-item"
      className={cn(
        // A *named* group. The sidebar root is itself an unnamed `group`
        // (`sidebar.tsx:210`), and `group-hover:` matches any hovered ancestor
        // carrying it — so an anonymous group here would reveal every row's
        // menu button the moment the pointer entered the sidebar at all.
        "group/row hover:bg-muted focus-visible:bg-muted has-focus-visible:bg-muted has-data-[popup-open]:bg-muted relative flex h-8 items-center rounded-md transition-colors",
        active && "bg-muted",
      )}
    >
      {renaming ? (
        <BoardThreadRename
          thread={thread}
          onRename={(title) => onPatch({ title })}
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            onRenameEnd();
          }}
        />
      ) : (
        <Link
          href={`/board/${thread.threadId}`}
          aria-current={active ? "page" : undefined}
          title={thread.title}
          className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2.5 text-sm outline-none group-hover/row:pe-9 group-has-focus-visible/row:pe-9 group-has-data-[popup-open]/row:pe-9 focus-visible:ring-[3px]"
        >
          {unread && (
            <span
              aria-hidden
              data-slot="aui_board-thread-list-item-unread"
              className="bg-primary size-1.5 shrink-0 rounded-full"
            />
          )}
          <span
            className={cn("min-w-0 flex-1 truncate", unread && "font-medium")}
          >
            {thread.title}
          </span>
          {unread && <span className="sr-only">Unread</span>}
        </Link>
      )}

      <BoardThreadMenu
        ref={triggerRef}
        pinned={thread.pinned}
        onPin={() => onPatch({ pinned: !thread.pinned })}
        // Unread is the absence of a read, not a flag of its own: one nullable
        // timestamp cannot disagree with itself the way a flag and a date can.
        onMarkUnread={() => onPatch({ readAt: null })}
        onRename={onRenameStart}
        onDelete={onDelete}
      />
    </div>
  );
};

const BoardThreadRename: FC<{
  thread: BoardThread;
  onRename: (title: string) => void;
  onDone: (restoreFocus: boolean) => void;
}> = ({ thread, onRename, onDone }) => {
  const [value, setValue] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter commits and then blurs, so without this the commit runs twice.
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    // An empty or unchanged name is a cancel, not a write. Sending it would
    // cost a request to rename the thread to what it is already called.
    if (next && next !== thread.title) onRename(next);

    onDone(restoreFocus);
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_board-thread-list-item-rename"
      aria-label="Rename board"
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

const BoardThreadMenu: FC<{
  ref?: React.Ref<HTMLButtonElement>;
  pinned: boolean;
  onPin: () => void;
  onMarkUnread: () => void;
  onRename: () => void;
  onDelete: () => void;
}> = ({ ref, pinned, onPin, onMarkUnread, onRename, onDelete }) => (
  <Menu>
    <MenuTrigger
      ref={ref}
      render={
        <Button
          variant="ghost"
          size="icon-xs"
          // Revealed on hover, on focus anywhere in the row, and while its own
          // menu is open — so it is reachable by keyboard and does not vanish
          // out from under the pointer that opened it.
          className="absolute end-1.5 top-1/2 -translate-y-1/2 p-0 opacity-0 group-hover/row:opacity-100 group-has-focus-visible/row:opacity-100 data-[popup-open]:opacity-100"
        />
      }
    >
      <MoreHorizontalIcon className="size-3.5" />
      <span className="sr-only">Board options</span>
    </MenuTrigger>
    <MenuContent side="right" align="start">
      <MenuItem onClick={onPin}>
        {pinned ? <PinOffIcon /> : <PinIcon />}
        {pinned ? "Unpin" : "Pin"}
      </MenuItem>
      <MenuItem onClick={onMarkUnread}>
        <EyeOffIcon />
        Mark as unread
      </MenuItem>
      <MenuItem onClick={onRename}>
        <PencilIcon />
        Rename
      </MenuItem>
      <MenuItem variant="destructive" onClick={onDelete}>
        <TrashIcon />
        Delete
      </MenuItem>
    </MenuContent>
  </Menu>
);

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
