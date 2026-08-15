import { execFile } from 'child_process'
import { existsSync, watchFile, unwatchFile, watch, readFileSync, promises as fsPromises, type Stats } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { BrowserWindow } from 'electron'
import { getLoginShellEnv } from './pty-manager'

// --- Session tracking ---

interface SessionEntry {
  cwd: string
  claudeSessionId: string
  win: BrowserWindow
  jsonlPath: string
  titleDone: boolean
  planDetected: boolean
  pendingClear: boolean
  dirWatcher: ReturnType<typeof watch> | null
  /** Byte offset already scanned — only the appended region is read each tick. */
  scanOffset: number
  /** Carry-over for a trailing partial (unterminated) line between reads. */
  scanPartial: string
}

const sessions = new Map<string, SessionEntry>()

// --- Title generation queue (prevent concurrent CLI spawns) ---

interface TitleJob {
  sessionId: string
  userMessage: string
  /** Session cwd — the CLI runs there so its throwaway transcript lands in the
   *  project's own directory instead of polluting ~/.claude/projects/-/. */
  cwd: string
  resolve: (title: string) => void
  reject: (err: Error) => void
}

const titleQueue: TitleJob[] = []
let activeTitleJobs = 0
const MAX_CONCURRENT_TITLES = 1

function processNextTitle(): void {
  if (activeTitleJobs >= MAX_CONCURRENT_TITLES || titleQueue.length === 0) return
  const job = titleQueue.shift()!
  activeTitleJobs++
  runTitleGeneration(job.sessionId, job.userMessage, job.cwd)
    .then(job.resolve)
    .catch(job.reject)
    .finally(() => {
      activeTitleJobs--
      processNextTitle()
    })
}

// --- Helpers (shared) ---

function getJsonlPath(cwd: string, claudeSessionId: string): string {
  const projectDir = cwd.replace(/[/.]/g, '-')
  return join(homedir(), '.claude', 'projects', projectDir, `${claudeSessionId}.jsonl`)
}

// --- Public API ---

export function scheduleTitleGeneration(
  sessionId: string,
  cwd: string,
  claudeSessionId: string,
  win: BrowserWindow
): void {
  const jsonlPath = getJsonlPath(cwd, claudeSessionId)
  const entry: SessionEntry = {
    cwd, claudeSessionId, win, jsonlPath,
    titleDone: false, planDetected: false, pendingClear: false, dirWatcher: null,
    scanOffset: 0, scanPartial: ''
  }
  sessions.set(sessionId, entry)

  watchJsonl(sessionId, entry)

  // Watch the project directory for new JSONL files (created by /clear)
  const projectDir = dirname(jsonlPath)
  if (existsSync(projectDir)) {
    const dirWatcher = watch(projectDir, (eventType, filename) => {
      if (eventType !== 'rename' || !filename?.endsWith('.jsonl')) return
      const newFile = join(projectDir, filename)
      if (newFile === entry.jsonlPath || !existsSync(newFile)) return
      // Only process if this session is expecting a /clear (set via notifyClear from PTY input)
      if (!entry.pendingClear) return

      // Small delay — file may not be fully written yet when the watch event fires
      setTimeout(() => {
        if (!existsSync(newFile) || !entry.pendingClear) return
        // Check if this new JSONL is a /clear continuation
        try {
          const head = readFileSync(newFile, { encoding: 'utf-8', flag: 'r' })
          if (!head.includes('<command-name>/clear</command-name>')) return
        } catch { return }

        console.log(`[title-gen] Session ${sessionId}: /clear detected (new JSONL: ${filename})`)
        entry.pendingClear = false

        // Stop watching old JSONL, switch to new one
        try { unwatchFile(entry.jsonlPath) } catch { /* ignore */ }
        entry.jsonlPath = newFile
        entry.titleDone = false
        entry.planDetected = false
        entry.scanOffset = 0
        entry.scanPartial = ''

        // Start watching the new JSONL for title generation
        watchJsonl(sessionId, entry)

        // Notify renderer to reset the session name
        if (entry.win && !entry.win.isDestroyed()) {
          entry.win.webContents.send(`session:clear-detected:${sessionId}`)
        }
      }, 500)
    })
    entry.dirWatcher = dirWatcher
  }
}

function watchJsonl(sessionId: string, entry: SessionEntry): void {
  let lastSize = 0
  watchFile(entry.jsonlPath, { persistent: false, interval: 2000 }, (curr: Stats) => {
    if (curr.size === 0) return
    // File shrank (rotated/truncated) — rescan from the beginning.
    if (curr.size < lastSize) {
      entry.scanOffset = 0
      entry.scanPartial = ''
    }
    if (curr.size === lastSize) return
    lastSize = curr.size
    void processJsonl(sessionId, entry)
  })

  if (existsSync(entry.jsonlPath)) {
    void processJsonl(sessionId, entry)
  }
}

export function cleanup(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (entry) {
    try { unwatchFile(entry.jsonlPath) } catch { /* ignore */ }
    try { entry.dirWatcher?.close() } catch { /* ignore */ }
  }
  sessions.delete(sessionId)
  // Remove any queued title jobs for this session
  const queueIdx = titleQueue.findIndex((j) => j.sessionId === sessionId)
  if (queueIdx !== -1) {
    titleQueue[queueIdx].reject(new Error('Session cleaned up'))
    titleQueue.splice(queueIdx, 1)
  }
}

/** Mark a session as expecting a /clear — called when PTY input contains /clear */
export function notifyClear(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (entry) {
    entry.pendingClear = true
    console.log(`[title-gen] Session ${sessionId}: /clear pending`)
  }
}

// --- JSONL processing ---

async function processJsonl(sessionId: string, entry: SessionEntry): Promise<void> {
  // Nothing left to detect — stop polling this transcript entirely. Without this
  // the watcher re-read the whole (multi-MB, ever-growing) JSONL every 2s for the
  // session's entire life just to look for a plan that most sessions never emit.
  if (entry.titleDone && entry.planDetected) {
    try { unwatchFile(entry.jsonlPath) } catch { /* ignore */ }
    return
  }

  // Read only the appended region since the last scan.
  let chunk: string
  try {
    const fh = await fsPromises.open(entry.jsonlPath, 'r')
    try {
      const stat = await fh.stat()
      if (stat.size <= entry.scanOffset) return
      const length = stat.size - entry.scanOffset
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, entry.scanOffset)
      entry.scanOffset = stat.size
      chunk = buf.toString('utf-8')
    } finally {
      await fh.close()
    }
  } catch {
    return
  }

  // Keep any trailing partial line for the next read; only process complete lines.
  const text = entry.scanPartial + chunk
  const lastNl = text.lastIndexOf('\n')
  if (lastNl === -1) {
    entry.scanPartial = text
    return
  }
  entry.scanPartial = text.slice(lastNl + 1)
  const lines = text.slice(0, lastNl).split('\n')

  // Title: first valid user message (lines are scanned in order across reads).
  if (!entry.titleDone) {
    for (const line of lines) {
      if (!line.includes('"type":"user"')) continue
      const raw = parseUserMessage(line)
      if (!raw) continue
      // Skip-and-keep-scanning: a line that is Claude Code's own bookkeeping must
      // not latch titleDone, or the session is stuck with a garbage title forever.
      const userMessage = sanitizeUserMessage(raw)
      if (!userMessage) continue

      entry.titleDone = true
      console.log(`[title-gen] Session ${sessionId} message: "${userMessage.slice(0, 80)}"`)

      generateTitle(sessionId, userMessage, entry.cwd)
        .then((title) => {
          if (entry.win && !entry.win.isDestroyed()) {
            entry.win.webContents.send(`session:auto-title:${sessionId}`, title)
          }
        })
        .catch(() => {})
      break
    }
  }

  // Plan: any line carrying a planFilePath.
  if (!entry.planDetected) {
    for (const line of lines) {
      if (!line.includes('planFilePath')) continue
      try {
        const parsed = JSON.parse(line)
        const planPath = extractPlanPath(parsed)
        if (planPath && existsSync(planPath)) {
          entry.planDetected = true
          if (entry.win && !entry.win.isDestroyed()) {
            entry.win.webContents.send(`session:plan-detected:${sessionId}`, planPath)
          }
          console.log(`[title-gen] Session ${sessionId}: plan detected at ${planPath}`)
          break
        }
      } catch {
        // skip malformed line
      }
    }
  }
}

// --- Parsing ---

function parseUserMessage(line: string): string | null {
  try {
    const entry = JSON.parse(line)
    // Claude Code's own marker for "not a real user turn" — the local-command
    // caveat, session reminders, and other injected entries all carry it.
    if (entry.isMeta === true) return null
    if (entry.type === 'user' && entry.message?.content) {
      const text =
        typeof entry.message.content === 'string'
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? entry.message.content
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { text: string }) => b.text)
                .join(' ')
            : ''
      if (text.trim()) return text.trim()
    }
  } catch {
    // malformed
  }
  return null
}

function extractPlanPath(entry: Record<string, unknown>): string | null {
  if (typeof entry.planFilePath === 'string') return entry.planFilePath

  const content = (entry.message as Record<string, unknown>)?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
        const planPath = (block.input as Record<string, unknown>)?.planFilePath
        if (typeof planPath === 'string') return planPath
      }
    }
  }
  return null
}

// --- Title generation ---

function generateTitle(sessionId: string, userMessage: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    titleQueue.push({ sessionId, userMessage, cwd, resolve, reject })
    processNextTitle()
  })
}

function runTitleGeneration(sessionId: string, userMessage: string, cwd: string): Promise<string> {
  const prompt = `Generate a short 2-4 word title for this Claude Code terminal session based on what the user asked.
Rules:
- Return ONLY the title, no quotes, no explanation
- Be specific about what the user is working on
- Lowercase, like an IDE tab title
- Examples: "fix auth middleware", "add dark mode", "refactor store", "debug api"

User's message:
${userMessage}`

  const env = { ...getLoginShellEnv() }
  delete env.CLAUDECODE

  // Without a cwd the CLI inherits Electron's (usually `/`) and drops a throwaway
  // transcript into ~/.claude/projects/-/ on every single title generation.
  const runCwd = existsSync(cwd) ? cwd : undefined

  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--model', 'haiku'],
      { cwd: runCwd, env, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('[title-gen] claude CLI error:', err.message, stderr)
          const fallback = heuristicTitle(userMessage)
          if (fallback) {
            console.log(`[title-gen] Session ${sessionId} (heuristic): "${fallback}"`)
            resolve(fallback)
          } else {
            reject(new Error(stderr || err.message))
          }
          return
        }
        const title = stdout.trim()
        if (!title) {
          const fallback = heuristicTitle(userMessage)
          if (fallback) {
            console.log(`[title-gen] Session ${sessionId} (heuristic): "${fallback}"`)
            resolve(fallback)
          } else {
            reject(new Error('Empty response from Claude'))
          }
          return
        }
        const wordCount = title.split(/\s+/).length
        if (wordCount > 6 || /^(I |I'm |I'll |The |This |You |It |We |My |Let )/.test(title)) {
          console.warn(`[title-gen] Rejected bad title for ${sessionId}: "${title}"`)
          const fallback = heuristicTitle(userMessage)
          if (fallback) {
            console.log(`[title-gen] Session ${sessionId} (heuristic): "${fallback}"`)
            resolve(fallback)
          } else {
            reject(new Error('Response is not a valid title'))
          }
          return
        }
        console.log(`[title-gen] Session ${sessionId}: "${title}"`)
        resolve(title)
      }
    )
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

// --- Helpers ---

function isValidMessage(msg: string): boolean {
  if (msg.length < 5) return false
  if (msg.startsWith('/')) return false
  if (/^(y|n|yes|no)$/i.test(msg)) return false
  return true
}

/**
 * Claude Code records its own bookkeeping as `"type":"user"` turns: the local-command
 * caveat, the slash-command echo, that command's stdout/stderr, and session reminders.
 * None of it was typed by the user, so none of it may become a title.
 */
const WRAPPER_TAGS =
  'local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder'

/** A complete wrapper block, e.g. `<command-name>/usage</command-name>`. */
const WRAPPER_BLOCK_RE = new RegExp(`<(${WRAPPER_TAGS})\\b[^>]*>[\\s\\S]*?</\\1>`, 'gi')

/**
 * The same wrapper left unterminated (truncated content) — strip to the end.
 * Anchored to the start on purpose: a truncated wrapper always leads the entry,
 * whereas the same tag mid-sentence is a user talking about it.
 */
const WRAPPER_OPEN_RE = new RegExp(`^\\s*<(${WRAPPER_TAGS})\\b[^>]*>[\\s\\S]*$`, 'i')

/** A self-closing wrapper, e.g. `<command-args />`. */
const WRAPPER_SELF_CLOSING_RE = new RegExp(`<(${WRAPPER_TAGS})\\b[^>]*/>`, 'gi')

/** Whatever is left is a lone XML-ish block (`<attachment>…</attachment>`) rather than prose. */
const LONE_TAG_BLOCK_RE = /^<([a-z][\w:.-]*)\b[^>]*>(?:[\s\S]*<\/\1>\s*)?$/i

/**
 * Strip Claude Code's synthetic wrappers and return what the user actually typed,
 * or `null` when nothing meaningful is left. Callers should skip the line and keep
 * scanning — a later user turn is a far better title than a sanitized wrapper.
 */
function sanitizeUserMessage(msg: string): string | null {
  const stripped = msg
    .replace(WRAPPER_BLOCK_RE, ' ')
    .replace(WRAPPER_SELF_CLOSING_RE, ' ')
    .replace(WRAPPER_OPEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!stripped) return null
  // Defensive: an unlisted wrapper we do not know about yet. A prompt that merely
  // mentions a tag inline still passes, since only a leading block matches here.
  if (LONE_TAG_BLOCK_RE.test(stripped)) return null
  if (!isValidMessage(stripped)) return null
  return stripped
}

const PREFIX_RE =
  /^(please\s+|can you\s+|could you\s+|I want to\s+|I need to\s+|I need you to\s+|help me\s+)/i

function heuristicTitle(message: string): string | null {
  // Backstop: a tab label is never markup. Anything angle-bracketed that survived
  // the transcript filters gets dropped here rather than rendered in the sidebar.
  let text = message.split(/\n/)[0]
  text = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .trim()
  text = text.replace(PREFIX_RE, '')
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
  if (words.length === 0) return null
  const title = words.join(' ').toLowerCase().trim()
  return title || null
}
