import { useSessionStore } from '../store/session-store'
import type { Session, SessionGroup } from '../store/session-store'
import { usePinnedStore, getPinnedState } from '../store/pinned-store'
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
  const sessions: RemoteSession[] = state.sessions
    .filter((s) => s.sessionType === 'local')
    .map((s) => {
      const group = groupOfSession(state.groups, s.id)
      return {
        id: s.id,
        name: s.name,
        folderName: s.folderName,
        cwd: s.cwd,
        mode: remoteSessionMode(s),
        groupId: group?.id ?? null,
        color: group?.color ?? null,
        alive: s.alive,
        // The wire has two activity states; a session that ended is reported
        // through `alive` instead.
        activityStatus: s.activityStatus === 'active' ? 'active' : 'idle',
        promptWaiting: s.promptWaiting,
        agentState: s.agentState ?? null,
        unseenActivity: s.hasUnseenActivity,
        detectedUrl: s.detectedUrl,
        serverStatus: s.serverStatus,
        // Main-side facts. Filled in by the remote server from the pty manager.
        tmuxName: null,
        remotable: false
      }
    })

  const groups: RemoteGroup[] = state.groups.map((g) => ({
    id: g.id,
    name: g.name,
    cwd: g.cwd,
    color: g.color ?? null,
    sessionIds: g.sessionIds
  }))

  // Launchable templates from `.clave` files, so a remote client can start a
  // whole workspace the same way the sidebar does.
  const pinnedGroups: RemotePinnedGroup[] = usePinnedStore.getState().pinnedGroups.map((pg) => ({
    id: pg.id,
    name: pg.name,
    cwd: pg.cwd,
    state: getPinnedState(pg)
  }))

  return { sessions, groups, pinnedGroups, focusedSessionId: state.focusedSessionId }
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

  const unsubSessions = useSessionStore.subscribe((state, prevState) => {
    if (
      state.sessions === prevState.sessions &&
      state.groups === prevState.groups &&
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

  return () => {
    if (timer !== null) clearTimeout(timer)
    unsubSessions()
    unsubPinned()
  }
}
