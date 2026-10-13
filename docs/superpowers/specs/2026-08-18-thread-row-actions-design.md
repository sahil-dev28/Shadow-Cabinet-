# Thread row actions: pin, unread, rename, delete

A board in the sidebar is a dead link today. You can open it and nothing else —
there is no way to name it something you would recognise, get rid of one you
opened by mistake, keep an important one at the top, or tell at a glance which
boards have answered since you last looked.

This adds the four actions behind a three-dot button on each row: **Pin**,
**Mark as unread**, **Rename**, **Delete**.

## Where state lives

Two stores already hold a thread between them, and both are needed.

- **Mastra thread** — the title, written once by the chair step's `titleThread`.
- **`board_sessions`** — the questions, answers, and rounds, in Mongo or in a
  JSON file when there is no `MONGODB_URI`.

Pin and read state go in the Mastra thread's `metadata`. It is the same record
the title lives on, so a rename and a pin are one write against one row rather
than a new store to keep in step with an existing one.

```ts
interface BoardThreadMetadata {
  pinned?: boolean;
  /** ISO timestamp of the last time the CEO opened this board. */
  readAt?: string;
}
```

`memory.updateThread` requires `title` and `metadata` together, so every write
reads the thread first and passes back the fields it is not changing. This is
the dance `titleThread` already does at `board-session.ts:596`; the new code
follows it rather than inventing a second pattern.

**The store merges metadata, it does not replace it.** `updateThread` performs
`{ ...thread.metadata, ...metadata }`, so a key left out of the write is not
removed — it is preserved. Clearing `readAt` therefore writes an explicit
`null`; `delete`-ing the key silently keeps the old timestamp, which makes a
board impossible to mark unread. `readAt` is nullable rather than optional for
this reason, and the merge lives in a pure `nextMetadata` function so the rule
is testable on its own.

## The unread rule

A board is unread when it produced an answer after the CEO last opened it:

```
unread = answeredAt > readAt   (or readAt is absent)
```

`answeredAt` is the **board session's** timestamp, not Mastra's `updatedAt`.
The distinction is the whole rule. Mastra's clock moves on every agent turn —
including the `updateThread` call that stamps `readAt` — so a row keyed off it
would mark itself unread the instant it was marked read. The session clock moves
only when a board finishes, which is exactly the event "there is something new
here" is meant to name.

Sorting keeps using Mastra's clock, as it does today, so a thread resumed from
the composer still sorts as recent.

**Mark as unread** clears `readAt`. It does not set a flag of its own: one
nullable timestamp cannot disagree with itself the way a flag and a timestamp
can.

## Backend

`shadow-cabinet-server/src/mastra/routes/board-thread.ts` — a new file for the
single-thread verbs, next to the existing `board-threads.ts` collection route.

### `PATCH /board/threads/:threadId`

Body is a partial of `{ title, pinned, readAt }`; `readAt: null` clears it.
Reads the thread, merges, writes back. `404` when Mastra does not know the
thread — there is nothing to write metadata onto.

### `DELETE /board/threads/:threadId`

Hard delete. Three stores, in this order:

1. `deleteBoardSessions(threadId)` — new, mirrors the Mongo-or-JSON split the
   rest of `board-sessions.ts` uses.
2. `clearPendingRun(threadId)` — exists. A halted run left behind would resume
   into a thread with no history.
3. `memory.deleteThread(threadId)` — messages and vectors.

Sessions go first on purpose. They are what `GET /board/threads` lists from, so
if the run dies halfway the row is already gone from the sidebar rather than
left pointing at a thread whose memory was deleted underneath it.

### `GET /board/threads`

Three fields per row: `pinned`, `unread`, `answeredAt`.

## Web

- `app/api/threads/[threadId]/route.ts` — PATCH and DELETE proxies, the same
  shape as the GET proxy next door. `MASTRA_API_URL` stays server-side.
- `components/ui/menu.tsx` — Base UI `Menu` wrapper, styled like `dialog.tsx`.
- `components/ui/alert-dialog.tsx` — Base UI `AlertDialog` wrapper, for the
  delete confirmation.
- `components/assistant-ui/board-thread-list.tsx` — the work.

### The list

Pinned boards group above the rest under their own label. Within each group the
existing newest-first order holds. An unread row shows a dot before its title
and its title in medium weight.

The three-dot trigger sits at the row's end, revealed on hover, on focus within
the row, and while its own menu is open — so it is reachable by keyboard and
does not flicker while you are using it.

The row is a **named** group (`group/row`), and every reveal variant is scoped
to that name. `group-hover:` matches any hovered ancestor carrying `.group`,
and the sidebar root is itself one (`sidebar.tsx:210`) — so an anonymous group
reveals every row's button the moment the pointer enters the sidebar at all.
`sidebar.tsx` already names its own groups (`group/menu-item`) for this reason.

### Rename

Renaming swaps the row for an inline `Input`. Enter commits, Escape cancels,
blur commits. `thread-list.tsx` already solves the two problems this has —
committing exactly once across the blur-and-Enter race, and putting focus back
on the trigger afterwards — so that logic is lifted rather than rewritten.

An empty or unchanged title is a cancel, not a write.

### Delete

Opens an alert dialog naming the board. Confirming removes the row optimistically.
If the CEO deletes the board they are currently reading, the page navigates to
`/`, which redirects to a fresh board id.

### Marking read

An effect keyed on `pathname` fires the `readAt` PATCH when the open board is
listed and unread. It runs from the sidebar, which is mounted on every board
page, so there is no second place that has to remember to do it.

It records which board it has seen **before** testing whether that board is
unread, not after. Claiming it only on the unread path leaves the effect armed
against a board that was already read — so marking the open board unread would
flip it unread, re-arm the effect, and mark it read again in the same tick.
Seen means seen, whatever the row said when it was first observed.

### Optimistic updates

Pin, unread, and rename all update local state first and send the PATCH behind
it. A failed request rolls the row back to what the server last said. The
sidebar is not worth a spinner, and a pin that waits on a round trip feels
broken.

## Testing

The pure rules are unit-tested, which is where the things that can actually be
wrong live:

- `lib/board-threads.test.ts` — `isUnread` across answered-after-read,
  answered-before-read, and never-read, plus the case that pins the design:
  Mastra's `updatedAt` moving after the read must not re-unread the row.
  `groupThreads` for pinned-first ordering, order held inside each group, and
  the all-pinned and none-pinned degenerate cases.
- `routes/board-thread.test.ts` — `nextMetadata`, including the merge trap:
  clearing writes `null` and keeps the key, and unrelated metadata survives.

`deleteBoardSessions` is covered by live verification rather than a unit test.
It writes to a fixed path beside its own module, and the repo has no fixture
harness for the data layer, so a test would either clobber real dev data or
exist only to re-assert `Array.prototype.filter`.

## Out of scope

"Add to project" and "Move to group" from the reference screenshot. There are no
projects or groups in this app, and a menu item that opens an empty submenu is
worse than one that is not there.
