# Sessions vanish from the sidebar during `npm run dev`

## Symptom

`feat/fork-proposals` was left running overnight via `npm run dev` with ~12 sessions open.
By morning the sidebar showed zero sessions. Believing they were gone, two new sessions were
created into the empty UI. A full quit and relaunch of the dev app brought all ~12 original
sessions back — but not cleanly grouped, and it was unclear whether the two sessions created
that morning still existed anywhere.

No process was ever killed and no tmux session was ever destroyed. This is a UI/state bug, not
data loss: the underlying tmux sessions stayed alive, undetected, the whole time.

## Background: every session is tmux-backed

As of this branch, tmux mode is the default backing for *all* sessions, not just remote/iPad
ones (`src/main/ipc-handlers/pty-handlers.ts:44`). Every session's `claude`/shell process runs
inside a tmux session on a single shared socket:

- Socket name: `clave`, always invoked as `-L clave` (`src/main/pty-manager.ts:190`), never `-S`.
  Resolves to tmux's standard default path, `${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/clave`.
- Individual tmux session names are deterministic per cwd + mode:
  `clave-<sanitized-folder>-<djb2 hash of cwd|modeTag>` (`pty-manager.ts:306-322`), disambiguated
  with `-2`, `-3`, ... on collision (`uniqueTmuxName`, `pty-manager.ts:821-834`).
- The tmux server is explicitly configured with `set -g destroy-unattached off`
  (`pty-manager.ts:257`) — it will not reap a session just because nothing is attached.
- There is no idle TTL, no session-expiry sweep, and no `powerMonitor`/sleep-wake handling
  anywhere in `src/main`. Nothing in the app proactively kills or times out a tmux session.

So once a session exists, it persists indefinitely on the `clave` socket regardless of whether
any window is attached to it, whether the Mac slept, or whether the Electron renderer is even
displaying it.

## The actual bug: adoption is keyed off the wrong state

There are two independent stores of "which sessions exist":

1. **Sidecar files** — one JSON file per tmux session, written on every spawn/rename, at
   `<userData>/clave-tmux-sessions/<tmuxName>.json` (`pty-manager.ts:386-409`). Deleted only on
   explicit user-close.
2. **`ptyManager.sessions`** — the main process's own in-memory `Map`, populated as sessions are
   spawned or adopted during the current process's lifetime.

At launch, the renderer asks main which tmux sessions are "adoptable" via
`listAdoptableTmuxSessions()` (`pty-manager.ts:1139-1193`). That function reconciles the sidecar
files against the live tmux server state — but then filters out anything **already present in
`ptyManager.sessions`** (`alreadyAdopted`, lines 1144-1148, 1187). The implicit assumption is
that "already in main's map" means "already showing in the UI." That assumption only holds if
main and the renderer restart together.

`npm run dev` runs the renderer through Vite/HMR, which can reload the renderer on its own
without restarting main — a websocket reconnect after the Mac sleeps, or a hot-reload of a
module (e.g. `session-store.ts`, `AppShell.tsx`) that React Fast Refresh can't apply in place and
downgrades to a full page reload. When that happens:

- The renderer's Zustand `sessions`/`groups` state resets to empty, along with module-level
  guards like `tmuxAdoptionStarted` (`AppShell.tsx:41`) and `sidebarPersistEnabled` /
  `lastPersistedGroups` (`session-store.ts:211-213`).
- Main's `ptyManager.sessions` is untouched and still holds every real session.
- `listAdoptableTmuxSessions()` returns an empty list — every live, perfectly healthy session is
  filtered out by `alreadyAdopted`, so the renderer never calls `addSession()` for any of them
  (`AppShell.tsx:103-189`).
- Because zero sessions were adopted, `restoreGroups` is skipped (`AppShell.tsx:178`), and
  `enableSidebarPersistence()` runs anyway in the `finally` block (`AppShell.tsx:186`),
  immediately writing the store's now-empty `groups`/`displayOrder` over the real
  `<userData>/sidebar-layout.json` (`session-store.ts:247-251`). A subscriber then keeps
  re-persisting that empty state on every subsequent change (`session-store.ts:1259-1263`).

At this point the sidebar is empty, the layout file on disk has been overwritten with empty
groups, and every original tmux session, PTY, and sidecar file is completely intact and unaware
anything happened.

Creating new sessions into this state works normally and gets its own sidecar file — but if the
new session's cwd/mode matches an already-live-but-invisible session, `uniqueTmuxName` collides
with it in the tmux server and bumps to the next numeric suffix (e.g. a third session in a
folder that already had two from the night before becomes `...-3`), which is itself observable
evidence that a "new" session was in fact created alongside sessions the UI had already forgotten
about.

Quitting and relaunching the whole app starts a fresh main process with an empty
`ptyManager.sessions` map, so `alreadyAdopted` is empty and every sidecar-registered tmux session
(old and new alike) becomes adoptable again — which is why a full restart, and only a full
restart, brings everything back.

## Why this reproduces specifically in this dev setup

- `mainWindow.on('closed', ...)` calls `ptyManager.killAll()` (`src/main/index.ts:64-68`), which
  clears `ptyManager.sessions` without touching the tmux server or sidecars — so closing/quitting
  the window is the only thing that resets the state adoption depends on.
- Nothing in `src/main/index.ts` handles `render-process-gone`, `unresponsive`, or otherwise
  detects/repairs a renderer-only reload.
- `AppShell.tsx` and `session-store.ts` are both under active edit on this branch (recent commits
  add tmux loading, remote stream attach, and preference-file handling to exactly these areas),
  which increases how often Fast Refresh can't hot-apply a change and falls back to a full page
  reload — the exact trigger condition for this bug.

## Fix (2026-08-18)

The core change re-keys adoption off the state that actually reflects the UI — the renderer's
own store — instead of main's `ptyManager.sessions`:

1. **`listAdoptableTmuxSessions()` no longer filters out sessions main already tracks**
   (`pty-manager.ts`). Sidecars reconciled against the live tmux server are returned whether or
   not this process has them in its map; main cannot know what the renderer is displaying.
2. **`PtyManager.spawn()` re-adopts in place**: when `adoptTmuxName`/`adoptSessionId` match a
   live in-memory session, it returns that record instead of building a new one — which would
   have overwritten the map entry (orphaning the running tmux client) and `-A`-attached a
   duplicate client onto the same tmux session.
3. **The `pty:spawn` IPC handler detects an in-place re-adoption** and skips resetting the
   session's agent-event log and rescheduling title generation — the session is mid-run — while
   still rewiring the data/exit listeners.
4. **The renderer dedupes adoption against its own store** (`AppShell.tsx`): survivors whose id
   is already displayed are skipped but still counted for `restoreGroups`, protecting the Fast
   Refresh hot-apply case where the store survives while the module-level adoption latch resets.
5. **`enableSidebarPersistence()` no longer writes an empty layout at launch**
   (`session-store.ts`): an empty store at enable time means nothing was adopted (or adoption
   failed), so the saved `sidebar-layout.json` is left intact rather than clobbered with
   emptiness. A deliberate close-everything during a run still persists through the subscriber.

Verified end to end with a Playwright Electron run (isolated `--user-data-dir`, shared `clave`
socket left untouched): two tmux-backed sessions created, `page.reload()` to simulate the
renderer-only reload, both tabs reappear with their original session ids, no duplicate tmux
sessions or clients, the saved layout keeps both entries, and the reattached terminal both
replays its scrollback and accepts new input.
