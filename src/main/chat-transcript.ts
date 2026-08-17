import { homedir } from 'os'
import { join } from 'path'
import type { RemoteChatEvent, RemoteChatKind, RemoteChatRole } from '../shared/remote-protocol'

/**
 * Normalization of Claude Code's transcript JSONL into the small wire schema
 * remote chat clients consume (`RemoteChatEvent` in remote-protocol.ts).
 *
 * The transcript is CC's internal format with no stability guarantee, so this
 * file is deliberately the ONLY place that knows its shape. The rules:
 *   • entry types we render → one or more events
 *   • entry types we know and deliberately skip → nothing
 *   • entry types we have never seen → one `kind: 'unknown'` event, so the
 *     client can see that the schema drifted and offer Mirror instead of
 *     silently showing a hole
 * A line that does not parse as JSON at all is skipped (a tail read can catch
 * a write mid-flight; the complete line is re-read on the next drain).
 *
 * Everything here is pure and Electron-free so `scripts/verify-chat-transcript.mjs`
 * can import it directly, same as pty-replay.ts.
 */

// Body caps. The wire is a phone on cellular; a 3 MB base64 image inside a
// tool_result is exactly what chat mode exists to avoid.
export const CHAT_TEXT_MAX = 16_000
export const CHAT_THINKING_MAX = 2_500
export const CHAT_TOOL_INPUT_MAX = 400
export const CHAT_TOOL_RESULT_MAX = 2_000

/** Entry types that exist today and carry nothing a chat reader needs. Listed
 *  explicitly so a genuinely new type still surfaces as `unknown`. */
const SKIPPED_ENTRY_TYPES = new Set([
  'attachment',
  'summary',
  'system',
  'mode',
  'last-prompt',
  'ai-title',
  'custom-title',
  'agent-name',
  'bridge-session',
  'queue-operation',
  'queued-message',
  'file-history-snapshot',
  'file-history-delta',
  'progress'
])

/** Synthetic wrapper tags CC embeds in user-turn strings (slash commands,
 *  local command output, injected reminders). Same set title-generator strips. */
const WRAPPER_TAG =
  /<\/?(?:local-command-caveat|local-command-stdout|local-command-stderr|command-message|command-args|system-reminder)>/g
const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/** The directory CC keeps a project's transcripts in: the cwd with `/` and `.`
 *  swapped for `-`. Verified against every project dir on this machine and
 *  identical to the two existing copies (title-generator.ts,
 *  session-export-handlers.ts). */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

export function deriveTranscriptPath(cwd: string, claudeSessionId: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(cwd), `${claudeSessionId}.jsonl`)
}

function clamp(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

function entryTs(entry: Record<string, unknown>): number {
  const raw = entry.timestamp
  if (typeof raw !== 'string') return 0
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function event(
  id: string,
  ts: number,
  role: RemoteChatRole,
  kind: RemoteChatKind,
  body: string,
  max: number,
  extra?: Partial<RemoteChatEvent>
): RemoteChatEvent {
  const { text, truncated } = clamp(body, max)
  return { id, ts, role, kind, text, ...(truncated ? { truncated } : {}), ...extra }
}

/** A user-turn string with CC's synthetic wrappers stripped. A slash command
 *  renders as the command line itself; injected-only content renders as ''. */
export function cleanUserText(raw: string): string {
  const command = COMMAND_NAME.exec(raw)
  if (command) {
    // A slash-command turn renders as what the user typed: the command plus
    // its args. The `<command-message>` copy duplicates the name and is noise.
    const args = COMMAND_ARGS.exec(raw)?.[1]?.trim() ?? ''
    return [command[1].trim(), args].filter(Boolean).join(' ')
  }
  return raw.replace(SYSTEM_REMINDER_BLOCK, '').replace(WRAPPER_TAG, '').trim()
}

/** Flatten a tool_result's `content` (string, or blocks of text/image) into a
 *  short excerpt. Images are named, never carried. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[image]')
  }
  return parts.join('\n').trim()
}

/** One line for a tool call: the input's most telling field, or compact JSON.
 *  The client shows it next to `toolName`. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of [
    'command',
    'file_path',
    'pattern',
    'path',
    'url',
    'query',
    'prompt',
    'description'
  ]) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  try {
    const json = JSON.stringify(record)
    return json === '{}' ? '' : json
  } catch {
    return ''
  }
}

function userEvents(entry: Record<string, unknown>, idBase: string): RemoteChatEvent[] {
  const message = entry.message as Record<string, unknown> | undefined
  const content = message?.content
  const ts = entryTs(entry)

  if (typeof content === 'string') {
    const text = cleanUserText(content)
    if (!text) return []
    // CC records an interrupt as a bracketed user turn; that is an event, not
    // something the user said.
    if (text.startsWith('[Request interrupted')) {
      return [event(`${idBase}#0`, ts, 'system', 'meta', 'Interrupted', CHAT_TEXT_MAX)]
    }
    return [event(`${idBase}#0`, ts, 'user', 'text', text, CHAT_TEXT_MAX)]
  }

  if (!Array.isArray(content)) return []
  const events: RemoteChatEvent[] = []
  content.forEach((block, index) => {
    if (!block || typeof block !== 'object') return
    const b = block as Record<string, unknown>
    const id = `${idBase}#${index}`
    if (b.type === 'text' && typeof b.text === 'string') {
      const text = cleanUserText(b.text)
      if (text) events.push(event(id, ts, 'user', 'text', text, CHAT_TEXT_MAX))
    } else if (b.type === 'image') {
      events.push(event(id, ts, 'user', 'text', '[image]', CHAT_TEXT_MAX))
    } else if (b.type === 'tool_result') {
      events.push(
        event(id, ts, 'user', 'tool_result', toolResultText(b.content), CHAT_TOOL_RESULT_MAX, {
          ...(typeof b.tool_use_id === 'string' ? { toolUseId: b.tool_use_id } : {}),
          ...(b.is_error === true ? { isError: true } : {})
        })
      )
    }
  })
  return events
}

function assistantEvents(entry: Record<string, unknown>, idBase: string): RemoteChatEvent[] {
  const message = entry.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  const ts = entryTs(entry)
  const model = typeof message?.model === 'string' ? { model: message.model } : {}

  const events: RemoteChatEvent[] = []
  content.forEach((block, index) => {
    if (!block || typeof block !== 'object') return
    const b = block as Record<string, unknown>
    const id = `${idBase}#${index}`
    if (b.type === 'text' && typeof b.text === 'string') {
      const text = b.text.trim()
      if (text) events.push(event(id, ts, 'assistant', 'text', text, CHAT_TEXT_MAX, model))
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      const text = b.thinking.trim()
      if (text) events.push(event(id, ts, 'assistant', 'thinking', text, CHAT_THINKING_MAX, model))
    } else if (b.type === 'tool_use') {
      events.push(
        event(id, ts, 'assistant', 'tool_use', summarizeToolInput(b.input), CHAT_TOOL_INPUT_MAX, {
          ...(typeof b.name === 'string' ? { toolName: b.name } : {}),
          ...(typeof b.id === 'string' ? { toolUseId: b.id } : {}),
          ...model
        })
      )
    }
  })
  return events
}

/**
 * Normalize one transcript line. `fallbackId` must be stable for this line
 * across re-reads (the byte offset of the line start serves); it ids entries
 * that carry no uuid of their own.
 */
export function parseTranscriptLine(line: string, fallbackId: string): RemoteChatEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let entry: Record<string, unknown>
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    entry = parsed as Record<string, unknown>
  } catch {
    return []
  }

  const type = entry.type
  if (typeof type !== 'string') return []

  // Subagent (sidechain) traffic lives in the same file; a chat of the main
  // conversation must not interleave a worker's whole tool log.
  if (entry.isSidechain === true) return []
  if (entry.isMeta === true) return []

  const idBase = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `line-${fallbackId}`

  switch (type) {
    case 'user':
      return userEvents(entry, idBase)
    case 'assistant':
      return assistantEvents(entry, idBase)
    case 'permission-mode': {
      const mode = entry.permissionMode
      if (typeof mode !== 'string' || !mode) return []
      return [
        event(
          `${idBase}#0`,
          entryTs(entry),
          'system',
          'meta',
          `Permission mode: ${mode}`,
          CHAT_TEXT_MAX
        )
      ]
    }
    default:
      if (SKIPPED_ENTRY_TYPES.has(type)) return []
      return [event(`${idBase}#0`, entryTs(entry), 'system', 'unknown', type, CHAT_TEXT_MAX)]
  }
}

/**
 * Parse a chunk of transcript bytes into events plus the trailing partial line
 * (a write caught mid-flight, completed on the next drain). `baseOffset` is the
 * absolute file offset of the chunk start, used for stable fallback ids.
 */
export function parseTranscriptChunk(
  chunk: string,
  baseOffset: number
): { events: RemoteChatEvent[]; partial: string } {
  const lastNewline = chunk.lastIndexOf('\n')
  if (lastNewline < 0) return { events: [], partial: chunk }

  const events: RemoteChatEvent[] = []
  let lineStart = 0
  const complete = chunk.slice(0, lastNewline)
  for (const line of complete.split('\n')) {
    events.push(...parseTranscriptLine(line, String(baseOffset + lineStart)))
    // Advance in BYTES so a fallback id is the same whether the line was read
    // by a backfill or by the live tail (their chunk boundaries differ).
    lineStart += Buffer.byteLength(line, 'utf-8') + 1
  }
  return { events, partial: chunk.slice(lastNewline + 1) }
}
