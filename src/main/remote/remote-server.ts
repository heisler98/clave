import * as os from 'os'
import { createHash, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'
import { callRenderer } from '../mcp/mcp-bridge'
import { buildAttachInfo, getSessionTmuxFacts } from './remote-attach'
import {
  getDevice,
  getRequireApproval,
  isRemoteEnabled,
  listDevices,
  loadRemoteServerState,
  onDevicesChanged,
  saveRemoteServerState,
  upsertDevice
} from './remote-state'
import {
  REMOTE_COMMANDS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteAttachMode,
  type RemoteClientMessage,
  type RemoteDevice,
  type RemoteDeviceStatus,
  type RemoteEventKind,
  type RemoteGroup,
  type RemoteServerMessage,
  type RemoteSession,
  type RemoteSnapshot,
  type RemoteStatus
} from '../../shared/remote-protocol'

/**
 * The control plane for remote clients: a WebSocket server on loopback that
 * serves the session model and forwards commands to the renderer's existing
 * MCP dispatcher. Terminal bytes never travel over it; a client attaches with
 * the descriptor from `remote-attach.ts` on its own SSH channel.
 *
 * The security posture is `mcp-server.ts` and `ClaveChannelServer` line for
 * line: loopback only, mandatory bearer token compared in constant time,
 * bounded frames, and off until the user turns it on. The only way to reach
 * the port from outside this Mac is an SSH forward, which already costs an
 * authenticated login.
 */

/** Reject frames larger than this to bound memory pressure from a hostile peer. */
const MAX_PAYLOAD_BYTES = 1024 * 1024 // 1 MB

/** Advertised to the client so it can degrade instead of guessing.
 *  `create` — the server normalizes `openSession` (default cwd, forced tmux)
 *  and the snapshot carries `recentDirs`/`homeDir` to pick a directory from. */
const CAPABILITIES = [
  'patch',
  'attach',
  'commands',
  'geometry',
  'mirror',
  'takeover',
  'watch',
  'create'
]

const ATTACH_MODES: readonly RemoteAttachMode[] = ['mirror', 'takeover', 'watch']

interface ClientState {
  clientId: string | null
  deviceName: string
  /** Set by `subscribe`; unsubscribed sockets get no patches or events. */
  subscribed: boolean
}

let wss: WebSocketServer | null = null
let serverToken: string | null = null
let boundPort: number | null = null
let lastError: string | undefined
const clients = new Map<WebSocket, ClientState>()

/** The last model pushed by the renderer, with main's tmux facts merged in. */
let cachedSnapshot: RemoteSnapshot | null = null
/** Monotonic, bumped only when a push actually changed something. Clients ask
 *  "what changed since N", which is the iOS resume path: every foregrounding is
 *  a fresh connection, and refetching the whole model each time is wasteful. */
let stateVersion = 0
let snapshotRequest: Promise<void> | null = null

// ── Auth ───────────────────────────────────────────────────────────────────

function tokenMatches(authHeader: string | undefined): boolean {
  if (!serverToken || !authHeader?.startsWith('Bearer ')) return false
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const presented = createHash('sha256').update(authHeader.slice('Bearer '.length)).digest()
  const expected = createHash('sha256').update(serverToken).digest()
  return timingSafeEqual(presented, expected)
}

/**
 * The pairing status the client should act on. A device the user approved is
 * approved forever; a revoked one stays revoked whatever the toggle says; an
 * unseen one only waits when approval is required, so turning the requirement
 * off releases devices that were already waiting.
 */
function effectivePairing(device: RemoteDevice | undefined): RemoteDeviceStatus {
  if (device?.status === 'revoked') return 'revoked'
  if (device?.status === 'approved') return 'approved'
  return getRequireApproval() ? 'pending' : 'approved'
}

/** The user-facing reason this socket may not act, or null when it may. */
function blockedReason(state: ClientState): string | null {
  if (!state.clientId) return 'Send a hello message before anything else.'
  switch (effectivePairing(getDevice(state.clientId))) {
    case 'approved':
      return null
    case 'revoked':
      return 'This device was revoked in Clave on the Mac.'
    default:
      return 'This device is waiting for approval in Clave on the Mac.'
  }
}

// ── Wire helpers ───────────────────────────────────────────────────────────

function send(ws: WebSocket, message: RemoteServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function broadcast(message: RemoteServerMessage): void {
  const data = JSON.stringify(message)
  for (const [ws, state] of clients) {
    if (state.subscribed && !blockedReason(state) && ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

// ── Snapshot, diffing, versioning ──────────────────────────────────────────

/** Sessions are flat records of scalars, so key-wise equality is exact and
 *  survives the renderer emitting its keys in a different order. */
function sameSession(a: RemoteSession, b: RemoteSession | undefined): boolean {
  if (!b) return false
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] !== right[key]) return false
  }
  return true
}

function sameGroups(a: RemoteGroup[], b: RemoteGroup[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The renderer holds the UI model; tmux names, attachability, and the home
 *  directory live only in main. Compose both here so a client sees one
 *  coherent snapshot. */
function mergeHostFacts(snapshot: RemoteSnapshot): RemoteSnapshot {
  return {
    ...snapshot,
    homeDir: os.homedir(),
    sessions: snapshot.sessions.map((session) => {
      const facts = getSessionTmuxFacts(session.id)
      return {
        ...session,
        tmuxName: facts.tmuxName,
        remotable: facts.remotable,
        reason: facts.reason
      }
    })
  }
}

/**
 * Push a new model from the renderer. Diffs against the cached one and
 * broadcasts the smaller of a patch and a full state; a push that changed
 * nothing costs a version bump of zero and sends nothing at all.
 */
export function pushSnapshot(snapshot: RemoteSnapshot): void {
  const next = mergeHostFacts(snapshot)
  const prev = cachedSnapshot
  cachedSnapshot = next

  if (!prev) {
    stateVersion += 1
    broadcast({ type: 'state', version: stateVersion, snapshot: next })
    return
  }

  const prevById = new Map(prev.sessions.map((s) => [s.id, s]))
  const nextIds = new Set(next.sessions.map((s) => s.id))
  const changedSessions = next.sessions.filter((s) => !sameSession(s, prevById.get(s.id)))
  const removedSessionIds = prev.sessions.map((s) => s.id).filter((id) => !nextIds.has(id))
  const groupsChanged = !sameGroups(prev.groups, next.groups)
  const focusChanged = prev.focusedSessionId !== next.focusedSessionId
  // `patch` carries no pinnedGroups, recentDirs, or homeDir fields, so a
  // change to any of them can only be expressed as a full state. Rare enough
  // that dedicated fields are not worth a protocol version.
  const pinnedChanged = JSON.stringify(prev.pinnedGroups) !== JSON.stringify(next.pinnedGroups)
  const dirsChanged =
    prev.homeDir !== next.homeDir ||
    JSON.stringify(prev.recentDirs) !== JSON.stringify(next.recentDirs)

  for (const id of removedSessionIds) lastGeometry.delete(id)

  if (
    changedSessions.length === 0 &&
    removedSessionIds.length === 0 &&
    !groupsChanged &&
    !focusChanged &&
    !pinnedChanged &&
    !dirsChanged
  ) {
    return
  }

  stateVersion += 1
  const state: RemoteServerMessage = { type: 'state', version: stateVersion, snapshot: next }
  if (pinnedChanged || dirsChanged) {
    broadcast(state)
    return
  }

  const patch: RemoteServerMessage = {
    type: 'patch',
    version: stateVersion,
    ...(changedSessions.length > 0 ? { sessions: changedSessions } : {}),
    ...(groupsChanged ? { groups: next.groups } : {}),
    ...(removedSessionIds.length > 0 ? { removedSessionIds } : {}),
    ...(focusChanged ? { focusedSessionId: next.focusedSessionId } : {})
  }
  // A patch that touches most of the model is bigger than the model, and it
  // also leaves the client resolving deltas for no gain. Send the state.
  broadcast(JSON.stringify(patch).length < JSON.stringify(state).length ? patch : state)
}

export function broadcastEvent(e: {
  kind: RemoteEventKind
  sessionId?: string
  title?: string
  body?: string
  cols?: number
  rows?: number
}): void {
  broadcast({ type: 'event', ...e })
}

/** The last geometry announced per session, so dragging the window produces one
 *  event per size rather than one per frame. */
const lastGeometry = new Map<string, string>()

/**
 * The host pane changed size, so every mirror client has to resize its own pty.
 *
 * This is not cosmetic. P0-A measured that tmux CLIPS a client narrower than the
 * window instead of scaling it, so a mirror left at the old size silently shows
 * a different screen from the Mac until it resyncs. The desktop is the only side
 * that knows the new size, which makes this the one event the client cannot do
 * without.
 */
export function notifyGeometry(sessionId: string, cols: number, rows: number): void {
  if (!wss || clients.size === 0) return
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return
  const key = `${cols}x${rows}`
  if (lastGeometry.get(sessionId) === key) return
  lastGeometry.set(sessionId, key)
  broadcastEvent({ kind: 'geometry', sessionId, cols, rows })
}

/**
 * Ask the renderer for the current model. Only main knows a client is waiting,
 * so this is the one place that pulls instead of being pushed. Concurrent
 * callers share one request; a rejection is survivable (the renderer may not
 * have registered the command yet, or the window may not exist).
 */
function requestSnapshot(): Promise<void> {
  if (!snapshotRequest) {
    snapshotRequest = callRenderer<RemoteSnapshot>('remoteSnapshot', {})
      .then((snapshot) => {
        if (snapshot?.sessions) pushSnapshot(snapshot)
      })
      .catch((err) => {
        console.warn('[remote] could not fetch a snapshot from the renderer', err)
      })
      .finally(() => {
        snapshotRequest = null
      })
  }
  return snapshotRequest
}

// ── Message handling ───────────────────────────────────────────────────────

function handleHello(ws: WebSocket, state: ClientState, msg: RemoteClientMessage): void {
  if (msg.type !== 'hello') return
  if (typeof msg.clientId !== 'string' || !msg.clientId) {
    send(ws, { type: 'error', error: 'hello needs a clientId.' })
    ws.close(4002, 'Bad hello')
    return
  }
  if (msg.protocol !== REMOTE_PROTOCOL_VERSION) {
    send(ws, {
      type: 'error',
      error:
        msg.protocol > REMOTE_PROTOCOL_VERSION
          ? 'Clave on this Mac is older than this app. Update Clave to connect.'
          : 'This app is older than Clave on this Mac. Update the app to connect.'
    })
    ws.close(4004, 'Protocol mismatch')
    return
  }

  // Upsert BEFORE this socket claims its clientId. `upsertDevice` fires the
  // roster listeners, and `handleDevicesChanged` sends a fresh `welcome` to
  // every socket that has one — including this one, which would then get two
  // welcomes for one hello: the roster's, and the one below. A client that
  // reads an unsolicited welcome as "the user just approved me" would act on a
  // promotion that never happened. Skipping this socket for its own hello is
  // free: `handleDevicesChanged` already ignores sockets with no clientId.
  state.deviceName = msg.deviceName || 'Unknown device'
  const device = upsertDevice(msg.clientId, state.deviceName, msg.appVersion)
  state.clientId = msg.clientId

  send(ws, {
    type: 'welcome',
    hostName: os.hostname(),
    claveVersion: app.getVersion(),
    protocol: REMOTE_PROTOCOL_VERSION,
    capabilities: CAPABILITIES,
    pairing: effectivePairing(device)
  })
}

async function handleSubscribe(
  ws: WebSocket,
  state: ClientState,
  sinceVersion?: number
): Promise<void> {
  const blocked = blockedReason(state)
  if (blocked) {
    send(ws, { type: 'error', error: blocked })
    return
  }
  state.subscribed = true

  if (!cachedSnapshot) await requestSnapshot()
  if (!cachedSnapshot) {
    send(ws, { type: 'error', error: 'Clave is still starting up. Try again in a moment.' })
    return
  }

  // Only an exactly-current client can be served a delta: no patch history is
  // kept, so any other version resyncs from a full state. That is the normal
  // case after an iOS background, and P0-D measured the cost as negligible.
  if (sinceVersion === stateVersion) {
    send(ws, { type: 'patch', version: stateVersion })
    return
  }
  send(ws, { type: 'state', version: stateVersion, snapshot: cachedSnapshot })
}

async function handleCommand(
  ws: WebSocket,
  state: ClientState,
  msg: Extract<RemoteClientMessage, { type: 'command' }>
): Promise<void> {
  const blocked = blockedReason(state)
  if (blocked) {
    send(ws, { type: 'result', id: msg.id, ok: false, error: blocked })
    return
  }
  // Allowlist before the string can reach the dispatcher: the wire is JSON, so
  // `command` is whatever the peer typed until it is checked against the
  // contract's list.
  if (!(REMOTE_COMMANDS as readonly string[]).includes(msg.command)) {
    send(ws, { type: 'result', id: msg.id, ok: false, error: `Unknown command "${msg.command}".` })
    return
  }
  // `openSession` is normalized rather than forwarded verbatim — the one
  // exception to the 1:1 dispatcher rule (documented on `RemoteCommand`):
  //   • cwd defaults to the MRU head, then the home directory, so an empty
  //     payload is the client's one-tap "new terminal";
  //   • tmuxMode is forced on, whatever the Mac's global setting says, because
  //     a session this client creates and then cannot attach to is useless.
  let payload = msg.payload
  if (msg.command === 'openSession') {
    const base = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const cwd =
      typeof base.cwd === 'string' && base.cwd
        ? base.cwd
        : (cachedSnapshot?.recentDirs[0] ?? os.homedir())
    payload = { ...base, cwd, tmuxMode: true }
  }
  try {
    const result = await callRenderer<unknown>(msg.command, payload)
    send(ws, { type: 'result', id: msg.id, ok: true, result: result ?? { ok: true } })
  } catch (err) {
    send(ws, {
      type: 'result',
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function handleAttach(
  ws: WebSocket,
  state: ClientState,
  msg: Extract<RemoteClientMessage, { type: 'attach' }>
): void {
  const blocked = blockedReason(state)
  if (blocked) {
    send(ws, { type: 'attachInfo', id: msg.id, ok: false, error: blocked })
    return
  }
  const mode = ATTACH_MODES.includes(msg.mode) ? msg.mode : 'mirror'
  try {
    send(ws, {
      type: 'attachInfo',
      id: msg.id,
      ok: true,
      info: buildAttachInfo(msg.sessionId, mode)
    })
  } catch (err) {
    send(ws, {
      type: 'attachInfo',
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function handleMessage(ws: WebSocket, state: ClientState, raw: string): void {
  let msg: RemoteClientMessage
  try {
    msg = JSON.parse(raw) as RemoteClientMessage
  } catch {
    send(ws, { type: 'error', error: 'Invalid message format.' })
    return
  }

  switch (msg?.type) {
    case 'hello':
      handleHello(ws, state, msg)
      break
    case 'subscribe':
      void handleSubscribe(ws, state, msg.sinceVersion)
      break
    case 'command':
      void handleCommand(ws, state, msg)
      break
    case 'attach':
      handleAttach(ws, state, msg)
      break
    case 'ping':
      send(ws, { type: 'pong' })
      break
    default:
      send(ws, { type: 'error', error: 'Unknown message type.' })
  }
}

/**
 * Roster changes take effect on live sockets: a revoked device is disconnected
 * on the spot rather than at its next message, and a device the user just
 * approved gets a fresh welcome so it can carry on without reconnecting.
 */
function handleDevicesChanged(): void {
  for (const [ws, state] of clients) {
    if (!state.clientId) continue
    const pairing = effectivePairing(getDevice(state.clientId))
    if (pairing === 'revoked') {
      send(ws, { type: 'error', error: 'This device was revoked in Clave on the Mac.' })
      ws.close(4003, 'Revoked')
      continue
    }
    if (pairing === 'approved') {
      send(ws, {
        type: 'welcome',
        hostName: os.hostname(),
        claveVersion: app.getVersion(),
        protocol: REMOTE_PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        pairing
      })
    }
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

function listen(port: number): Promise<{ server: WebSocketServer; port: number }> {
  return new Promise((resolve, reject) => {
    // Loopback explicitly: without a host, `ws` binds 0.0.0.0 and this becomes
    // full control of every agent session, reachable from the whole LAN.
    const server = new WebSocketServer({ port, host: '127.0.0.1', maxPayload: MAX_PAYLOAD_BYTES })
    const onError = (err: Error): void => {
      server.close()
      reject(err)
    }
    server.once('error', onError)
    server.once('listening', () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (address && typeof address === 'object') resolve({ server, port: address.port })
      else {
        server.close()
        reject(new Error('Could not determine the remote server port'))
      }
    })
  })
}

export async function startRemoteServer(): Promise<RemoteStatus> {
  if (wss) return getRemoteStatus()
  lastError = undefined

  // Default off. "Anyone who can SSH in could run code anyway" is true and is
  // still not a reason to bind a port the user never asked for.
  if (!isRemoteEnabled()) return getRemoteStatus()

  const { port, token } = loadRemoteServerState()
  if (!token) {
    // Fail closed, exactly like ClaveChannelServer: an unauthenticated control
    // plane hands over every session to anything that can reach the port.
    lastError = 'Remote access has no access token, so it will not start.'
    return getRemoteStatus()
  }
  serverToken = token

  let bound: { server: WebSocketServer; port: number }
  try {
    bound = await listen(port)
  } catch {
    // Persisted port taken (a second instance, or another process) — fall back
    // to an ephemeral one. Clients with a saved forward have to re-read the
    // port from remote-server.json.
    try {
      bound = await listen(0)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      serverToken = null
      return getRemoteStatus()
    }
  }

  wss = bound.server
  boundPort = bound.port
  saveRemoteServerState(boundPort, token)
  // Named listener, so repeated starts do not stack duplicates on the Set.
  onDevicesChanged(handleDevicesChanged)

  wss.on('connection', (ws, req) => {
    // A browser cannot set an Authorization header on a WebSocket, so the token
    // already excludes web pages; rejecting any Origin at all also shuts the
    // DNS-rebinding door, since a native client never sends one.
    if (req.headers.origin) {
      ws.close(4003, 'Forbidden origin')
      return
    }
    if (!tokenMatches(req.headers.authorization)) {
      ws.close(4001, 'Unauthorized')
      return
    }

    const state: ClientState = { clientId: null, deviceName: 'Unknown device', subscribed: false }
    clients.set(ws, state)

    ws.on('message', (data) => handleMessage(ws, state, data.toString()))
    ws.on('close', () => {
      clients.delete(ws)
    })
    ws.on('error', () => {
      clients.delete(ws)
    })
  })

  console.log(`[remote] listening on 127.0.0.1:${boundPort}`)
  // Warm the cache so the first subscribe answers immediately. A renderer that
  // has not registered the command yet just leaves the cache empty.
  void requestSnapshot()
  return getRemoteStatus()
}

export function stopRemoteServer(): void {
  for (const ws of clients.keys()) ws.close(1001, 'Remote access turned off')
  clients.clear()
  wss?.close()
  wss = null
  lastGeometry.clear()
  serverToken = null
  boundPort = null
  // The snapshot and its version survive a stop, so a client that reconnects
  // after a toggle can still be told whether anything changed.
}

export function getRemoteStatus(): RemoteStatus {
  const devices = listDevices()
  return {
    enabled: isRemoteEnabled(),
    running: wss !== null,
    port: boundPort,
    requireApproval: getRequireApproval(),
    // Revoked devices stay on the roster as a record, and are not devices that
    // can reach anything, so they are not counted here.
    deviceCount: devices.filter((d) => d.status !== 'revoked').length,
    pendingCount: devices.filter((d) => effectivePairing(d) === 'pending').length,
    ...(lastError ? { error: lastError } : {})
  }
}
