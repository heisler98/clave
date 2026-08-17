import { app } from 'electron'
import { mkdirSync, readFileSync, existsSync, rmSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'

/**
 * Claude Code notification events, sourced from the CC `Notification` lifecycle
 * hook.
 *
 * Each Clave-spawned `claude` session is launched with `--settings` injecting a
 * hook whose command is `cat >> <userData>/agent-events/<claveSessionId>.jsonl`
 * (see pty-manager.ts). Claude Code pipes the hook payload to that command on
 * stdin as **compact single-line JSON with one trailing newline** — verified
 * empirically against CC 2.1.233 by capturing real SessionStart/Stop/PreToolUse
 * hook stdin to a file, so `cat >>` yields well-formed JSONL. The parser below
 * is still defensive: a subprocess appends to these files concurrently, so a
 * read can land mid-write.
 *
 * This manager owns that directory, tails each file from the last consumed byte
 * offset, and hands notification-worthy events to its caller.
 *
 * Claude-only, exactly like agent-state-manager: the Antigravity and Codex CLIs
 * expose no hook mechanism, so their tabs fall back to the renderer's text
 * heuristic (use-terminal.ts).
 */

/** The subset of the CC hook payload we consume. Field names verified against
 *  the CC binary: the payload uses snake_case `notification_type`. Every hook
 *  payload also names the CC session and its transcript file, which is how
 *  chat-manager follows a session across /clear and resume rotation. */
export interface AgentNotificationEvent {
  hook_event_name?: string
  notification_type?: string
  message?: string
  title?: string
  cwd?: string
  session_id?: string
  transcript_path?: string
  /** SessionStart only: 'startup' | 'resume' | 'clear' | 'compact'. */
  source?: string
}

const SUFFIX = '.jsonl'

/**
 * Notification types that mean "the human is being waited on", each with the
 * copy used when the payload carries no `message` of its own. Every other type
 * CC can emit (auth_success, agent_completed, push_notification, the
 * computer_use_* pair, elicitation_response/complete) is deliberately ignored:
 * none of them is a request for input.
 */
const NOTIFY_TYPES: Readonly<Record<string, string>> = {
  permission_prompt: 'Claude needs your permission',
  worker_permission_prompt: 'A worker needs your permission',
  elicitation_dialog: 'Claude needs a response',
  elicitation_url_dialog: 'Claude needs a response',
  idle_prompt: 'Claude is waiting for your input',
  agent_needs_input: 'An agent needs your input'
}

/** Two identical events for one session inside this window fire once. Short on
 *  purpose: it exists to absorb a duplicate read, and must not swallow a second
 *  genuine prompt that follows the first. */
const DEDUPE_MS = 2000

/** Past this many bytes the file is dropped and started over. Hooks recreate it
 *  on the next append (`cat >>`), so a long-running session cannot grow an
 *  unbounded file that we re-read on every event. */
const MAX_FILE_BYTES = 512 * 1024

let eventDir: string | null = null
let watcher: FSWatcher | null = null

/** Bytes already consumed per session file, so each read only sees new records. */
const offsets = new Map<string, number>()
/** Last emitted body + timestamp per session, for the dedupe window. */
const lastEmit = new Map<string, { body: string; at: number }>()
/** Secondary consumers of the raw event stream (chat-manager follows
 *  SessionStart to keep transcript paths current). Called for every drained
 *  event, before notification filtering. */
const eventListeners = new Set<(claveSessionId: string, event: AgentNotificationEvent) => void>()

/** Register for every hook event of every session. Returns an unsubscribe. */
export function onAgentEvent(
  listener: (claveSessionId: string, event: AgentNotificationEvent) => void
): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function getEventDir(): string {
  if (!eventDir) {
    eventDir = join(app.getPath('userData'), 'agent-events')
    try {
      mkdirSync(eventDir, { recursive: true })
    } catch {
      // best-effort; reads/writes simply no-op if this fails
    }
  }
  return eventDir
}

/** Absolute path of the JSONL file a session's Notification hook appends to. */
export function eventFilePath(claveSessionId: string): string {
  return join(getEventDir(), `${claveSessionId}${SUFFIX}`)
}

/** Human-readable notification body for an event, or null if this event is not
 *  one the user should be interrupted for. Prefers CC's own `message` (already
 *  written as prose, e.g. "Claude needs your permission to use Bash"). */
export function notificationBody(event: AgentNotificationEvent): string | null {
  if (event.hook_event_name && event.hook_event_name !== 'Notification') return null
  const type = event.notification_type
  if (!type || !(type in NOTIFY_TYPES)) return null
  const message = typeof event.message === 'string' ? event.message.trim() : ''
  return message || NOTIFY_TYPES[type]
}

/**
 * Read every complete record appended since the last read. A trailing partial
 * line (a write caught mid-flight) is left unconsumed and picked up on the next
 * change event; anything that does not parse as JSON is skipped rather than
 * aborting the batch.
 */
function drain(claveSessionId: string, filePath: string): AgentNotificationEvent[] {
  let raw: Buffer
  try {
    if (!existsSync(filePath)) {
      offsets.delete(claveSessionId)
      return []
    }
    raw = readFileSync(filePath)
  } catch {
    return []
  }

  let offset = offsets.get(claveSessionId) ?? 0
  // File shrank → it was deleted and recreated (session respawn, rotation).
  if (raw.length < offset) offset = 0

  const chunk = raw.subarray(offset)
  const lastNewline = chunk.lastIndexOf(0x0a)
  if (lastNewline < 0) return []

  offsets.set(claveSessionId, offset + lastNewline + 1)

  const events: AgentNotificationEvent[] = []
  for (const line of chunk.subarray(0, lastNewline).toString('utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') events.push(parsed as AgentNotificationEvent)
    } catch {
      // Not a complete/valid record — skip it and keep going.
    }
  }

  if (raw.length > MAX_FILE_BYTES) {
    try {
      rmSync(filePath, { force: true })
      offsets.delete(claveSessionId)
    } catch {
      // ignore — worst case the file keeps growing
    }
  }

  return events
}

/**
 * Start watching the event directory. The callback fires once per
 * notification-worthy event with the Clave session id (derived from the
 * filename, so the mapping back to a tab needs no lookup table) and the body to
 * show. Safe to call multiple times — only the first call installs the watcher.
 */
export function startWatching(onNotify: (claveSessionId: string, body: string) => void): void {
  if (watcher) return
  const dir = getEventDir()
  try {
    watcher = watch(dir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (!name.endsWith(SUFFIX)) return
      const claveSessionId = name.slice(0, -SUFFIX.length)
      if (!claveSessionId) return

      for (const event of drain(claveSessionId, join(dir, name))) {
        for (const listener of eventListeners) {
          try {
            listener(claveSessionId, event)
          } catch {
            // A listener's failure must not cost the notification below.
          }
        }
        const body = notificationBody(event)
        if (!body) continue
        const now = Date.now()
        const previous = lastEmit.get(claveSessionId)
        if (previous && previous.body === body && now - previous.at < DEDUPE_MS) continue
        lastEmit.set(claveSessionId, { body, at: now })
        onNotify(claveSessionId, body)
      }
    })
  } catch {
    // watching unavailable — the feature degrades to no hook notifications
  }
}

/**
 * Drop a session's event file and its read cursor. Called both when a session is
 * spawned (so a file left behind by a previous run cannot replay stale events)
 * and when it exits (so nothing leaks).
 */
export function clearEvents(claveSessionId: string): void {
  offsets.delete(claveSessionId)
  lastEmit.delete(claveSessionId)
  try {
    rmSync(eventFilePath(claveSessionId), { force: true })
  } catch {
    // ignore
  }
}
