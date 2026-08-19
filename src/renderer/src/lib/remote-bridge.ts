import { getDisplayOrder, useSessionStore } from '../store/session-store'
import type { Session, SessionGroup } from '../store/session-store'
import { usePinnedStore, getPinnedState } from '../store/pinned-store'
import { useSessionDirStore, refreshRecentSessionDirs } from '../store/session-dir-store'
import type {
  RemoteGroup,
  RemotePinnedGroup,
  RemoteSession,
  RemoteSessionMode,
  RemoteSnapshot
} from '../../../shared/remote-protocol'

/**
 * Renderer half of the remote-access service. The sidebar model (sessions,
 * groups, focus) lives in this process's Zustand store, so the remote server in
 * main cannot read it directly: we push a `RemoteSnapshot` over IPC whenever the
 * model changes, and answer the `remoteSnapshot` dispatcher command on demand.
 *
 * The snapshot this file builds is only the UI half of the contract. Main owns
 * the tmux facts (`tmuxName`, `remotable`, `reason`) and overwrites them before
 * a client ever sees the session, so they are left at their empty values here.
 */

/** How long a burst of store updates is collected before one push goes out. */
const PUSH_DEBOUNCE_MS = 250

/** Same mapping as `sessionMode` in `mcp-dispatcher.ts`, in the wire's vocabulary. */
function remoteSessionMode(s: Session): RemoteSessionMode {
  if (s.antigravityMode) return 'antigravity'
  if (s.codexMode) return 'codex'
  if (s.claudeAgentsMode) return 'claude-agents'
  if (s.claudeMode) return 'claude'
  return 'terminal'
}

function groupOfSession(groups: SessionGroup[], sessionId: string): SessionGroup | undefined {
  return groups.find((g) => g.sessionIds.includes(sessionId))
}

/**
 * The renderer's view of the session model, shaped for the wire. Mirrors
 * `handleList` in `mcp-dispatcher.ts` and carries the extra fields a remote
 * client renders (folder name, activity, prompt state, detected server).
 */
export function buildRemoteSnapshot(): RemoteSnapshot {
  const state = useSessionStore.getState()

  // Local sessions only, same as handleList: OpenClaw-backed remote sessions
  // live on another machine and have no tmux session here to attach to.
  // Every field is coerced to the wire contract here, whatever the store holds.
  // `JSON.stringify` silently drops undefined keys, and the Swift client's
  // decoder hard-fails on a session missing a required field — which it reports
  // as a protocol mismatch, taking the whole snapshot down with it. One
  // malformed store entry must never cost the client its session list.
  const sessions: RemoteSession[] = state.sessions
    .filter((s) => s.sessionType === 'local')
    .map((s) => {
      const group = groupOfSession(state.groups, s.id)
      return {
        id: s.id,
        name: s.name || s.folderName || '',
        folderName: s.folderName ?? '',
        cwd: s.cwd ?? '',
        mode: remoteSessionMode(s),
        groupId: group?.id ?? null,
        color: group?.color ?? null,
        alive: s.alive !== false,
        // The wire has two activity states; a session that ended is reported
        // through `alive` instead.
        activityStatus: s.activityStatus === 'active' ? 'active' : 'idle',
        promptWaiting: s.promptWaiting ?? null,
        agentState: s.agentState ?? null,
        unseenActivity: s.hasUnseenActivity === true,
        detectedUrl: s.detectedUrl ?? null,
        serverStatus: s.serverStatus ?? null,
        // Main-side facts. Filled in by the remote server from the pty manager.
        tmuxName: null,
        remotable: false,
        chatAvailable: false
      }
    })

  const groups: RemoteGroup[] = state.groups.map((g) => ({
    id: g.id,
    name: g.name ?? '',
    cwd: g.cwd ?? null,
    color: g.color ?? null,
    sessionIds: g.sessionIds ?? []
  }))

  // The sidebar's top-level order, filtered to what this client can resolve.
  // `displayOrder` also carries file-tab ids and the ids of sessions the filter
  // above dropped, and an id a client cannot resolve is an id it would have to
  // guess about while reordering. The store computes a default order when the
  // array has never been written, so a fresh window still has one.
  const visibleIds = new Set<string>([...sessions.map((s) => s.id), ...groups.map((g) => g.id)])
  const displayOrder = getDisplayOrder(state).filter((id) => visibleIds.has(id))

  // Launchable templates from `.clave` files, so a remote client can start a
  // whole workspace the same way the sidebar does.
  const pinnedGroups: RemotePinnedGroup[] = usePinnedStore.getState().pinnedGroups.map((pg) => ({
    id: pg.id,
    name: pg.name,
    cwd: pg.cwd,
    state: getPinnedState(pg)
  }))

  return {
    sessions,
    groups,
    pinnedGroups,
    displayOrder,
    focusedSessionId: state.focusedSessionId,
    // Where a remote client can start a new session. Empty until the MRU
    // preference loads; `initRemoteBridge` kicks that load off and the store
    // subscription pushes again when it lands.
    recentDirs: useSessionDirStore.getState().recentDirs,
    // Main-side fact, same as tmuxName: the renderer has no `os`, so the
    // remote server overwrites this before a client sees it.
    homeDir: ''
  }
}

/**
 * Push the snapshot to main whenever it changes. Returns an unsubscribe fn.
 *
 * Two stages of filtering, because sessions emit activity updates continuously
 * and an unfiltered bridge would flood the IPC channel:
 *   1. a cheap reference check on the slices the snapshot is built from, so
 *      unrelated store writes (sidebar width, theme, file tabs) never schedule
 *      a push at all;
 *   2. a debounce plus a structural comparison against the last pushed payload,
 *      so a burst of writes costs one push and a write that leaves the snapshot
 *      identical costs none.
 */
export function initRemoteBridge(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastPushed: string | null = null

  const flush = (): void => {
    timer = null
    const snapshot = buildRemoteSnapshot()
    const serialized = JSON.stringify(snapshot)
    if (serialized === lastPushed) return
    lastPushed = serialized
    window.electronAPI?.remotePushSnapshot?.(snapshot)
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(flush, PUSH_DEBOUNCE_MS)
  }

  // Seed main with the current model, so a client connecting before the first
  // store write still gets a session list.
  schedule()
  // Load (and prune) the new-session MRU so snapshots carry real directories.
  // The store write it causes lands in the subscription below.
  refreshRecentSessionDirs()

  const unsubSessions = useSessionStore.subscribe((state, prevState) => {
    if (
      state.sessions === prevState.sessions &&
      state.groups === prevState.groups &&
      state.displayOrder === prevState.displayOrder &&
      state.focusedSessionId === prevState.focusedSessionId
    ) {
      return
    }
    schedule()
  })

  const unsubPinned = usePinnedStore.subscribe((state, prevState) => {
    if (state.pinnedGroups === prevState.pinnedGroups) return
    schedule()
  })

  const unsubDirs = useSessionDirStore.subscribe((state, prevState) => {
    if (state.recentDirs === prevState.recentDirs) return
    schedule()
  })

  return () => {
    if (timer !== null) clearTimeout(timer)
    unsubSessions()
    unsubPinned()
    unsubDirs()
  }
}
