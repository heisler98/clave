import { app } from 'electron'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { onAgentEvent, type AgentNotificationEvent } from './agent-event-manager'
import { deriveTranscriptPath, encodeProjectDir, parseTranscriptChunk } from './chat-transcript'
import { ptyManager } from './pty-manager'
import type { RemoteChatEvent, RemoteChatKey } from '../shared/remote-protocol'

/**
 * The host half of Chat mode: locates each Claude Code session's transcript
 * JSONL, tails it while remote clients are subscribed, and turns appended lines
 * into `RemoteChatEvent`s for remote-server.ts to fan out. Also carries chat
 * input the other way, into the session's PTY.
 *
 * Finding the file is the real problem this module solves. Clave passes
 * `--session-id` at spawn, so the transcript is derivable from the session's
 * cwd + claudeSessionId. But CC ROTATES the session id on /clear and resume,
 * and nothing in Clave updates the stored id afterwards (the sidecar goes
 * stale; see session-export-handlers.ts:61-74). So every hook payload's
 * `transcript_path` is captured via the SessionStart hook (pty-manager.ts) and
 * recorded here as an override, persisted across app restarts because the
 * agents themselves outlive the app inside tmux. Resolution order:
 *   1. the newest hook-reported path (survives rotation),
 *   2. derivation from cwd + claudeSessionId (covers sessions started before
 *      the hook existed), including the id-anchored fallbacks that survive a
 *      cwd encoding mismatch. Never mtime guessing: with parallel sessions in
 *      one project, "newest file" is how you tail a sibling's conversation.
 */

const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/** How much history one backfill will read from the end of the file. Beyond
 *  this the snapshot reports truncatedHistory. */
const BACKFILL_MAX_BYTES = 2 * 1024 * 1024
/** Largest single tail read; a bigger burst is consumed across drains. */
const DRAIN_MAX_BYTES = 8 * 1024 * 1024
/** A partial line larger than this (a multi-megabyte image result) is dropped
 *  rather than buffered forever; its remainder fails JSON.parse and is skipped. */
const PARTIAL_MAX_BYTES = 4 * 1024 * 1024
/** Safety-net poll interval behind fs.watch, and the wait for a transcript
 *  file that does not exist yet. */
const POLL_MS = 2000
/** Chat input larger than this is refused rather than typed into a TUI. */
const INPUT_MAX_CHARS = 100_000
/** Persisted overrides older than this are dropped at load. */
const OVERRIDE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Byte sequences behind RemoteChatKey names. Host-side only, on purpose: the
 *  client sends the name, so no byte table needs mirroring into Swift. */
const CHAT_KEY_SEQUENCES: Record<RemoteChatKey, string> = {
  escape: '\x1b',
  'shift-tab': '\x1b[Z',
  tab: '\t',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  '1': '1',
  '2': '2',
  '3': '3'
}

export interface ChatBackfill {
  events: RemoteChatEvent[]
  truncatedHistory: boolean
}

interface Tailer {
  path: string
  /** Bytes of the file consumed so far (including into `partial`). */
  offset: number
  /** Trailing incomplete line carried to the next drain. */
  partial: string
  watcher: FSWatcher | null
  poll: NodeJS.Timeout | null
  refs: number
}

interface OverrideRecord {
  path: string
  updatedAt: number
}

const tailers = new Map<string, Tailer>()
/** Hook-reported transcript paths, keyed by Clave session id. */
const overrides = new Map<string, OverrideRecord>()
let overridesLoaded = false

const eventCallbacks = new Set<(claveSessionId: string, events: RemoteChatEvent[]) => void>()
const resetCallbacks = new Set<(claveSessionId: string) => void>()

export function onChatEvents(
  cb: (claveSessionId: string, events: RemoteChatEvent[]) => void
): () => void {
  eventCallbacks.add(cb)
  return () => eventCallbacks.delete(cb)
}

export function onChatReset(cb: (claveSessionId: string) => void): () => void {
  resetCallbacks.add(cb)
  return () => resetCallbacks.delete(cb)
}

// ── Override persistence ───────────────────────────────────────────────────

function overridesFile(): string {
  return join(app.getPath('userData'), 'chat-transcripts.json')
}

function loadOverrides(): void {
  if (overridesLoaded) return
  overridesLoaded = true
  try {
    const raw = JSON.parse(readFileSync(overridesFile(), 'utf-8')) as Record<string, OverrideRecord>
    if (!raw || typeof raw !== 'object') return
    const cutoff = Date.now() - OVERRIDE_MAX_AGE_MS
    for (const [id, record] of Object.entries(raw)) {
      if (
        record &&
        typeof record.path === 'string' &&
        typeof record.updatedAt === 'number' &&
        record.updatedAt > cutoff &&
        isSafeTranscriptPath(record.path)
      ) {
        overrides.set(id, record)
      }
    }
  } catch {
    // No file yet, or unreadable — start empty.
  }
}

function saveOverrides(): void {
  try {
    const file = overridesFile()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(overrides)), 'utf-8')
    renameSync(tmp, file)
  } catch {
    // Best-effort: an unsaved override costs a re-derivation after restart.
  }
}

/** The hook log is user-writable, so a recorded path is only followed when it
 *  stays inside CC's own transcript store. */
function isSafeTranscriptPath(path: string): boolean {
  const resolved = resolve(path)
  return resolved.startsWith(CLAUDE_PROJECTS_ROOT + '/') && resolved.endsWith('.jsonl')
}

// ── Discovery ──────────────────────────────────────────────────────────────

/** Id-anchored transcript resolution (see the module comment for the order).
 *  Returns a path that may not exist yet (a brand-new session that has not
 *  written its first entry), or null when the session cannot have one. */
function resolveTranscriptPath(claveSessionId: string): string | null {
  loadOverrides()
  const override = overrides.get(claveSessionId)
  if (override) return override.path

  const session = ptyManager.getSession(claveSessionId)
  if (!session?.claudeSessionId) return null

  const derived = deriveTranscriptPath(session.cwd, session.claudeSessionId)
  if (existsSync(derived)) return derived

  // Encoding mismatch (symlinked or non-ASCII cwd): scan for the id elsewhere.
  try {
    for (const entry of readdirSync(CLAUDE_PROJECTS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(CLAUDE_PROJECTS_ROOT, entry.name, `${session.claudeSessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // projects root missing — fall through to the derived path
  }

  // Filename rotated but id kept inside: match the first line's sessionId.
  const projectDir = join(CLAUDE_PROJECTS_ROOT, encodeProjectDir(session.cwd))
  try {
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue
      const candidate = join(projectDir, name)
      if (firstLineSessionId(candidate) === session.claudeSessionId) return candidate
    }
  } catch {
    // project dir missing — the derived path is still the place to wait
  }

  return derived
}

function firstLineSessionId(filePath: string): string | null {
  try {
    const head = readFileSync(filePath, 'utf-8').slice(0, 4096)
    const firstLine = head.split('\n').find((l) => l.trim().length > 0)
    if (!firstLine) return null
    const parsed = JSON.parse(firstLine) as { sessionId?: unknown }
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : null
  } catch {
    return null
  }
}

/** Merged into the remote snapshot next to the tmux facts. */
export function isChatAvailable(claveSessionId: string): boolean {
  loadOverrides()
  if (overrides.has(claveSessionId)) return true
  return !!ptyManager.getSession(claveSessionId)?.claudeSessionId
}

// ── Tailing ────────────────────────────────────────────────────────────────

function emitEvents(claveSessionId: string, events: RemoteChatEvent[]): void {
  if (events.length === 0) return
  for (const cb of eventCallbacks) {
    try {
      cb(claveSessionId, events)
    } catch {
      // one consumer's failure must not stop the tail
    }
  }
}

function emitReset(claveSessionId: string): void {
  for (const cb of resetCallbacks) {
    try {
      cb(claveSessionId)
    } catch {
      // ignore
    }
  }
}

/** Read [start, end) of a file. Returns null when the file is unreadable. */
function readRange(path: string, start: number, end: number): Buffer | null {
  if (end <= start) return Buffer.alloc(0)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(end - start)
    let filled = 0
    while (filled < buffer.length) {
      const got = readSync(fd, buffer, filled, buffer.length - filled, start + filled)
      if (got <= 0) break
      filled += got
    }
    return buffer.subarray(0, filled)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function drainTailer(claveSessionId: string, tailer: Tailer): void {
  let size: number
  try {
    size = statSync(tailer.path).size
  } catch {
    return // file not there yet (or vanished); the poll keeps checking
  }

  if (size < tailer.offset) {
    // Truncated or replaced in place. Start over and tell clients their log
    // is stale so they refetch a coherent backfill.
    tailer.offset = 0
    tailer.partial = ''
    emitReset(claveSessionId)
    return
  }
  if (size === tailer.offset) return

  const end = Math.min(size, tailer.offset + DRAIN_MAX_BYTES)
  const chunk = readRange(tailer.path, tailer.offset, end)
  if (!chunk) return

  const combined = tailer.partial + chunk.toString('utf-8')
  const baseOffset = tailer.offset - Buffer.byteLength(tailer.partial, 'utf-8')
  const { events, partial } = parseTranscriptChunk(combined, baseOffset)
  tailer.offset += chunk.length
  tailer.partial = partial.length > PARTIAL_MAX_BYTES ? '' : partial

  emitEvents(claveSessionId, events)

  // A burst larger than one read: keep going until caught up.
  if (end < size) drainTailer(claveSessionId, tailer)
}

function wireTailer(claveSessionId: string, tailer: Tailer): void {
  tailer.watcher?.close()
  tailer.watcher = null
  if (tailer.poll) clearInterval(tailer.poll)

  try {
    tailer.watcher = watch(tailer.path, () => drainTailer(claveSessionId, tailer))
  } catch {
    // File does not exist yet — the poll below picks it up and re-wires.
  }

  tailer.poll = setInterval(() => {
    drainTailer(claveSessionId, tailer)
    if (!tailer.watcher && existsSync(tailer.path)) wireTailer(claveSessionId, tailer)
  }, POLL_MS)
}

function teardownTailer(tailer: Tailer): void {
  tailer.watcher?.close()
  tailer.watcher = null
  if (tailer.poll) clearInterval(tailer.poll)
  tailer.poll = null
}

/**
 * Read the last `limit` renderable events without touching a tailer cursor.
 * `endOffset` is the byte after the last complete line consumed, so a fresh
 * tailer can start exactly there: nothing lost, nothing double-read (a
 * trailing partial line is left for the tail to re-read whole).
 */
function readBackfill(path: string, limit: number): ChatBackfill & { endOffset: number } {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return { events: [], truncatedHistory: false, endOffset: 0 }
  }

  let start = Math.max(0, size - BACKFILL_MAX_BYTES)
  const raw = readRange(path, start, size)
  if (!raw) return { events: [], truncatedHistory: false, endOffset: 0 }

  let text = raw.toString('utf-8')
  if (start > 0) {
    // A mid-file start lands mid-line: skip to the first whole line.
    const firstNewline = text.indexOf('\n')
    if (firstNewline < 0) return { events: [], truncatedHistory: true, endOffset: 0 }
    start += Buffer.byteLength(text.slice(0, firstNewline + 1), 'utf-8')
    text = text.slice(firstNewline + 1)
  }

  const { events, partial } = parseTranscriptChunk(text, start)
  const truncatedHistory = start > 0 || events.length > limit
  const endOffset = start + Buffer.byteLength(text, 'utf-8') - Buffer.byteLength(partial, 'utf-8')
  return { events: events.slice(-limit), truncatedHistory, endOffset }
}

// ── Public surface for remote-server ───────────────────────────────────────

/**
 * Register one subscriber and return the backfill. Throws with a user-facing
 * message when the session cannot be chatted with. An empty backfill with a
 * live tailer is the normal state of a brand-new session.
 */
export function chatSubscribe(claveSessionId: string, limit: number): ChatBackfill {
  const path = resolveTranscriptPath(claveSessionId)
  if (!path) {
    throw new Error('Chat works with Claude Code sessions.')
  }

  const existing = tailers.get(claveSessionId)
  if (existing) {
    existing.refs += 1
    return readBackfill(existing.path, limit)
  }

  const backfill = readBackfill(path, limit)
  const tailer: Tailer = {
    path,
    offset: backfill.endOffset,
    partial: '',
    watcher: null,
    poll: null,
    refs: 1
  }
  tailers.set(claveSessionId, tailer)
  wireTailer(claveSessionId, tailer)
  return { events: backfill.events, truncatedHistory: backfill.truncatedHistory }
}

export function chatUnsubscribe(claveSessionId: string): void {
  const tailer = tailers.get(claveSessionId)
  if (!tailer) return
  tailer.refs -= 1
  if (tailer.refs <= 0) {
    teardownTailer(tailer)
    tailers.delete(claveSessionId)
  }
}

/** Session closed on the Mac: drop its tail and its override. */
export function clearChatSession(claveSessionId: string): void {
  const tailer = tailers.get(claveSessionId)
  if (tailer) {
    teardownTailer(tailer)
    tailers.delete(claveSessionId)
  }
  loadOverrides()
  if (overrides.delete(claveSessionId)) saveOverrides()
}

/** How long after the paste before the submitting Enter. Measured: an Enter in
 *  the same write as the paste is racy against the TUI's render loop (the text
 *  sometimes sits unsubmitted in the composer); a separated keystroke lands
 *  every time, the same way a human pastes then presses Enter. */
const SUBMIT_DELAY_MS = 150

/** Wrap a prompt in a bracketed paste and submit it. CC keeps DECSET 2004 on
 *  at its prompt, so a multi-line prompt arrives as one paste instead of one
 *  submit per line. Throws with user-facing text when it cannot be delivered. */
export function chatWriteInput(claveSessionId: string, text: string): void {
  if (!text || !text.trim()) throw new Error('There is no text to send.')
  if (text.length > INPUT_MAX_CHARS) throw new Error('This message is too long to send.')
  const session = ptyManager.getSession(claveSessionId)
  if (!session) throw new Error('This session is closed on the Mac.')
  if (!session.alive || !session.ptyProcess) {
    throw new Error('This session has exited. Start it again to send messages.')
  }
  ptyManager.write(claveSessionId, `\x1b[200~${text}\x1b[201~`)
  setTimeout(() => {
    const still = ptyManager.getSession(claveSessionId)
    if (still?.alive && still.ptyProcess) ptyManager.write(claveSessionId, '\r')
  }, SUBMIT_DELAY_MS)
}

export function chatPressKey(claveSessionId: string, key: RemoteChatKey): void {
  const sequence = CHAT_KEY_SEQUENCES[key]
  if (!sequence) throw new Error(`Unknown key "${key}".`)
  const session = ptyManager.getSession(claveSessionId)
  if (!session) throw new Error('This session is closed on the Mac.')
  if (!session.alive || !session.ptyProcess) {
    throw new Error('This session has exited. Start it again to send keys.')
  }
  ptyManager.write(claveSessionId, sequence)
}

// ── Hook feed ──────────────────────────────────────────────────────────────

function handleAgentEvent(claveSessionId: string, event: AgentNotificationEvent): void {
  if (event.hook_event_name !== 'SessionStart') return
  const reported = event.transcript_path
  if (typeof reported !== 'string' || !reported || !isSafeTranscriptPath(reported)) return

  loadOverrides()
  const current = overrides.get(claveSessionId)?.path
  if (current === reported) return
  overrides.set(claveSessionId, { path: reported, updatedAt: Date.now() })
  saveOverrides()

  // A live tail on the old file follows the session to its new one. Clients
  // hold a log of the old conversation, so they are told to refetch.
  const tailer = tailers.get(claveSessionId)
  if (tailer && tailer.path !== reported) {
    tailer.path = reported
    tailer.offset = 0
    tailer.partial = ''
    wireTailer(claveSessionId, tailer)
    emitReset(claveSessionId)
  }
}

let initialized = false

/** Call once at startup. Safe to call again. */
export function initChatManager(): void {
  if (initialized) return
  initialized = true
  onAgentEvent(handleAgentEvent)
}
