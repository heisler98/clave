// ── Clave remote-access protocol ───────────────────────────────────────────
//
// The wire contract between a Clave desktop instance (host) and a remote client
// such as the iPadOS app. See `docs/ipad-remote-client.md` for the design and
// `docs/p0-findings.md` for the measurements behind it.
//
// Two planes:
//   • CONTROL — this protocol, JSON over a WebSocket bound to 127.0.0.1 and
//     reached through an SSH `direct-tcpip` forward. Session model + commands.
//   • DATA    — terminal bytes, carried on separate SSH channels running
//     `tmux attach-session`. Never travels over this socket.
//
// MIRROR RULE: this file is the source of truth for the wire format. The Swift
// client mirrors it. Any change here must be mirrored in the iOS client in the
// same change, exactly like the `.clave` enum rule in CLAUDE.md.

/** Bumped on any breaking wire change. Clients refuse mismatched majors. */
export const REMOTE_PROTOCOL_VERSION = 1

/** Default tmux socket Clave's sessions live on (`pty-manager.ts` TMUX_SOCKET). */
export const REMOTE_TMUX_SOCKET = 'clave'

// ── Session model ──────────────────────────────────────────────────────────

export type RemoteSessionMode = 'claude' | 'codex' | 'antigravity' | 'claude-agents' | 'terminal'

export type RemoteActivityStatus = 'active' | 'idle'

/**
 * A session as a remote client sees it. Composed from two sources: the renderer
 * supplies the UI model (name, group, activity), the main process supplies the
 * tmux facts (`tmuxName`, `remotable`) that the renderer does not hold.
 *
 * EVERY field must actually be present on the wire: `JSON.stringify` silently
 * drops undefined values, and iOS clients before 2026-08 hard-fail the whole
 * snapshot on a session missing a required key (later clients degrade the one
 * session instead). `buildRemoteSnapshot` in `remote-bridge.ts` coerces each
 * field for exactly this reason — keep that invariant when adding fields.
 */
export interface RemoteSession {
  id: string
  name: string
  folderName: string
  cwd: string
  mode: RemoteSessionMode
  groupId: string | null
  color: string | null
  alive: boolean
  activityStatus: RemoteActivityStatus
  /** Non-null when the session is waiting on the user, e.g. a permission prompt. */
  promptWaiting: string | null
  agentState: string | null
  unseenActivity: boolean
  detectedUrl: string | null
  serverStatus: string | null
  /** The tmux session to attach to, or null when this session is not tmux-backed. */
  tmuxName: string | null
  /** False when the client cannot attach; `reason` says why in user-facing words. */
  remotable: boolean
  reason?: string
  /** True when this session can be viewed as a structured chat (a Claude Code
   *  session whose transcript main can locate). Merged in main, like tmuxName. */
  chatAvailable: boolean
}

export interface RemoteGroup {
  id: string
  name: string
  cwd: string | null
  color: string | null
  sessionIds: string[]
}

export interface RemotePinnedGroup {
  id: string
  name: string
  cwd: string | null
  state: string
}

export interface RemoteSnapshot {
  sessions: RemoteSession[]
  groups: RemoteGroup[]
  pinnedGroups: RemotePinnedGroup[]
  focusedSessionId: string | null
  /**
   * Where a session created from a remote client can start: the host's
   * most-recent-first new-session directories (the same MRU behind Cmd+N).
   * The renderer supplies these; they can be empty before preferences load.
   */
  recentDirs: string[]
  /**
   * The host user's home directory, the create-session fallback when the MRU
   * is empty. Main fills this in (the renderer has no `os` access), so the
   * renderer pushes '' and `remote-server.ts` overwrites it.
   */
  homeDir: string
}

// ── Attach descriptors ─────────────────────────────────────────────────────

/**
 * How the client should size its pty when attaching.
 *
 * P0-A measured this: a tmux client narrower than the window is CLIPPED to its
 * own width, so "attach small and render the host's big grid" does not work.
 *   • mirror   → size the pty to `cols`/`rows` below and scale the font down.
 *                `ignore-size` then guards the host from a transient mismatch.
 *   • takeover → size the pty to whatever the client wants; the tmux window
 *                reflows to follow it.
 *   • watch    → mirror sizing, read-only.
 */
export type RemoteAttachMode = 'mirror' | 'takeover' | 'watch'

export interface RemoteAttachInfo {
  sessionId: string
  tmuxName: string
  socket: string
  /** Absolute path to the tmux binary as resolved through the login shell. */
  tmuxPath: string
  /** Absolute path to Clave's generated tmux config. */
  configPath: string
  /** The host window's CURRENT geometry. Mirror clients must match it. */
  cols: number
  rows: number
  /** Client flags for `attach-session -f`, already chosen for the mode. */
  flags: string[]
  /** Fully-formed argv, so the client never composes a shell command itself. */
  argv: string[]
}

// ── Chat plane ─────────────────────────────────────────────────────────────
//
// A fourth per-session view next to Mirror/Takeover/Watch: a structured chat
// rendering of a Claude Code session, driven by the session's own transcript
// (`~/.claude/projects/<encoded-cwd>/<cc-session-id>.jsonl`) tailed in main.
// Events travel over this control plane, so a chat client needs no tmux data
// channel at all. Input travels the other way as `chatInput`/`chatKey` and is
// written into the session's PTY by main.
//
// The transcript is Anthropic's internal format with no stability guarantee, so
// the HOST normalizes entries into the small schema below and the client stays
// dumb: a CC format change is absorbed here, and an entry main does not
// recognize crosses the wire as `kind: 'unknown'` so the client can degrade
// (fall back to Mirror) instead of guessing.

export type RemoteChatRole = 'user' | 'assistant' | 'system'

export type RemoteChatKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'meta' | 'unknown'

/**
 * One renderable transcript entry. A single JSONL line can produce several
 * events (an assistant message holds thinking + text + tool_use blocks), so
 * ids are `<entry-uuid>#<block-index>`.
 *
 * Events are ordered as they appear in the transcript; `ts` is display
 * metadata, not a sort key (some entries carry no timestamp and get 0).
 */
export interface RemoteChatEvent {
  id: string
  /** Milliseconds since epoch, 0 when the entry carries no timestamp. */
  ts: number
  role: RemoteChatRole
  kind: RemoteChatKind
  /** The body: message text, thinking excerpt, tool input summary, tool result
   *  excerpt, or meta line. Truncated host-side; see `truncated`. */
  text: string
  truncated?: boolean
  /** tool_use only. */
  toolName?: string
  /** tool_use and tool_result: correlates a result to its call. */
  toolUseId?: string
  /** tool_result only. */
  isError?: boolean
  /** Assistant events: the model that produced the turn. */
  model?: string
}

/**
 * Keys a chat client may press without composing bytes. The byte sequences
 * live host-side only (`CHAT_KEY_SEQUENCES` in `chat-manager.ts`), so nothing
 * byte-shaped needs mirroring into Swift: the client sends the name.
 *   escape     interrupt the agent
 *   shift-tab  cycle the permission mode (plan / auto-accept / default)
 *   tab, enter, up, down, 1..3   drive permission prompts and menus
 */
export type RemoteChatKey =
  | 'escape'
  | 'shift-tab'
  | 'tab'
  | 'enter'
  | 'up'
  | 'down'
  | '1'
  | '2'
  | '3'

export const REMOTE_CHAT_KEYS: readonly RemoteChatKey[] = [
  'escape',
  'shift-tab',
  'tab',
  'enter',
  'up',
  'down',
  '1',
  '2',
  '3'
]

/** Backfill bounds for `chatSubscribe.limit`. */
export const CHAT_BACKFILL_DEFAULT_LIMIT = 200
export const CHAT_BACKFILL_MAX_LIMIT = 500

// ── Pairing ────────────────────────────────────────────────────────────────

export type RemoteDeviceStatus = 'approved' | 'pending' | 'revoked'

export interface RemoteDevice {
  clientId: string
  deviceName: string
  status: RemoteDeviceStatus
  firstSeenAt: number
  lastSeenAt: number
  appVersion?: string
}

// ── Client → server ────────────────────────────────────────────────────────

export type RemoteClientMessage =
  | {
      type: 'hello'
      clientId: string
      deviceName: string
      appVersion: string
      protocol: number
    }
  /** `sinceVersion` asks for a delta. The server sends a full snapshot when it
   *  cannot serve one, which is the normal case after an iOS background/resume. */
  | { type: 'subscribe'; sinceVersion?: number }
  | { type: 'command'; id: string; command: RemoteCommand; payload: unknown }
  | { type: 'attach'; id: string; sessionId: string; mode: RemoteAttachMode }
  /** Start receiving chat events for a session. Replied with `chatSnapshot`
   *  (the backfill); live `chatEvents` follow until `chatUnsubscribe` or the
   *  socket closes. Subscribing again re-sends a fresh backfill. */
  | { type: 'chatSubscribe'; id: string; sessionId: string; limit?: number }
  | { type: 'chatUnsubscribe'; sessionId: string }
  /** Send a prompt to the session. Main wraps the text in a bracketed paste
   *  (Claude Code keeps DECSET 2004 on at its prompt) and submits with Enter.
   *  Replied with a plain `result`. */
  | { type: 'chatInput'; id: string; sessionId: string; text: string }
  /** Press one named key (see RemoteChatKey). Replied with a plain `result`. */
  | { type: 'chatKey'; id: string; sessionId: string; key: RemoteChatKey }
  | { type: 'ping' }

/**
 * Commands map 1:1 onto the renderer's existing MCP dispatcher
 * (`src/renderer/src/lib/mcp-dispatcher.ts`). No new command layer is written:
 * this is the single biggest reason the host-service route is cheap.
 *
 * `openSession` is the one command the server normalizes before forwarding
 * (see `handleCommand` in `remote-server.ts`): a missing `cwd` is filled with
 * the MRU head or the home directory, and `tmuxMode` is forced true, because a
 * session a remote client creates and then cannot attach to is useless.
 */
export type RemoteCommand =
  | 'list'
  | 'openSession'
  | 'closeSession'
  | 'rename'
  | 'focus'
  | 'createGroup'
  | 'moveSession'
  | 'launchGroup'
  | 'addGroupTerminal'
  | 'openFile'
  | 'notify'

export const REMOTE_COMMANDS: readonly RemoteCommand[] = [
  'list',
  'openSession',
  'closeSession',
  'rename',
  'focus',
  'createGroup',
  'moveSession',
  'launchGroup',
  'addGroupTerminal',
  'openFile',
  'notify'
]

/**
 * What a remote client sends as the `openSession` payload. A subset of
 * `openSessionProgrammatically`'s full signature, spelled out here because it
 * crosses the wire and the Swift client composes it.
 *
 * Every field is optional: an empty payload means "a terminal in the default
 * directory", which is the iPad's one-tap New Session. `cwd` must be an
 * absolute path when present — pick it from the snapshot's `recentDirs` or
 * `homeDir` rather than composing paths client-side.
 */
export interface RemoteOpenSessionPayload {
  cwd?: string
  mode?: 'claude' | 'codex' | 'antigravity' | 'terminal'
  /** A preset tab label. Omitted, the host titles the session itself. */
  name?: string
}

// ── Server → client ────────────────────────────────────────────────────────

export type RemoteEventKind = 'activity' | 'prompt-waiting' | 'exit' | 'notification' | 'geometry'

export type RemoteServerMessage =
  | {
      type: 'welcome'
      hostName: string
      claveVersion: string
      protocol: number
      capabilities: string[]
      pairing: RemoteDeviceStatus
    }
  | { type: 'state'; version: number; snapshot: RemoteSnapshot }
  | {
      type: 'patch'
      version: number
      sessions?: RemoteSession[]
      groups?: RemoteGroup[]
      removedSessionIds?: string[]
      focusedSessionId?: string | null
    }
  | {
      type: 'event'
      kind: RemoteEventKind
      sessionId?: string
      title?: string
      body?: string
      /** Present on `geometry`: the host window resized, mirrors must resync. */
      cols?: number
      rows?: number
    }
  | { type: 'result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'attachInfo'; id: string; ok: boolean; info?: RemoteAttachInfo; error?: string }
  /** The chat backfill answering one `chatSubscribe`. `truncatedHistory` means
   *  older events exist that were not sent. */
  | {
      type: 'chatSnapshot'
      id: string
      ok: boolean
      sessionId: string
      events?: RemoteChatEvent[]
      truncatedHistory?: boolean
      error?: string
    }
  /** Live transcript events, in transcript order, only to chat subscribers of
   *  this session. A batch can repeat an id the backfill already sent (the
   *  subscribe/tail race); clients drop events whose id they already hold. */
  | { type: 'chatEvents'; sessionId: string; events: RemoteChatEvent[] }
  /** The session's transcript was re-pointed (a /clear or resume rotated the
   *  Claude Code session id). The client's log is stale: resubscribe. */
  | { type: 'chatReset'; sessionId: string }
  | { type: 'pong' }
  | { type: 'error'; error: string }

// ── Main ↔ renderer IPC surface ────────────────────────────────────────────
//
// Implemented in `src/main/ipc-handlers/remote-handlers.ts`, exposed on
// `window.electronAPI` by the preload. Named here so every side codes against
// one contract.

export const REMOTE_IPC = {
  /** invoke → RemoteStatus */
  getStatus: 'remote:get-status',
  /** invoke(enabled: boolean) → RemoteStatus */
  setEnabled: 'remote:set-enabled',
  /** invoke → RemoteDevice[] */
  listDevices: 'remote:list-devices',
  /** invoke(clientId: string) → RemoteDevice[] */
  approveDevice: 'remote:approve-device',
  /** invoke(clientId: string) → RemoteDevice[] */
  revokeDevice: 'remote:revoke-device',
  /** invoke(requireApproval: boolean) → RemoteStatus */
  setRequireApproval: 'remote:set-require-approval',
  /** send(snapshot: RemoteSnapshot) — renderer pushes its model on change */
  pushSnapshot: 'remote:push-snapshot',
  /** on(devices: RemoteDevice[]) — main tells the renderer the roster changed */
  devicesUpdated: 'remote:devices-updated'
} as const

export interface RemoteStatus {
  /** User preference. When false the server is not listening at all. */
  enabled: boolean
  /** True once the WebSocket server is bound. */
  running: boolean
  port: number | null
  requireApproval: boolean
  deviceCount: number
  pendingCount: number
  /** Populated when the server failed to start, for display in Settings. */
  error?: string
}

/**
 * The preload surface. `src/preload/index.d.ts` mixes this into ElectronAPI, so
 * renderer code gets these typed without importing from main.
 */
export interface RemoteElectronAPI {
  remoteGetStatus(): Promise<RemoteStatus>
  remoteSetEnabled(enabled: boolean): Promise<RemoteStatus>
  remoteSetRequireApproval(requireApproval: boolean): Promise<RemoteStatus>
  remoteListDevices(): Promise<RemoteDevice[]>
  remoteApproveDevice(clientId: string): Promise<RemoteDevice[]>
  remoteRevokeDevice(clientId: string): Promise<RemoteDevice[]>
  remotePushSnapshot(snapshot: RemoteSnapshot): void
  onRemoteDevicesUpdated(callback: (devices: RemoteDevice[]) => void): () => void
}
