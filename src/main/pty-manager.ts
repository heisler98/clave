import * as pty from 'node-pty'
import { execFile, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, INITIAL_COMMAND_DELAY_MS } from './constants'
import { stateFilePath } from './agent-state-manager'
import { eventFilePath } from './agent-event-manager'
import { getMcpRuntime, writeSessionMcpConfig, deleteSessionMcpConfig } from './mcp/mcp-runtime'
import { PtyReplayBuffer } from './pty-replay'

const isWindows = process.platform === 'win32'

/** Wrap a string as a single shell-quoted token (safe for embedding in `zsh -c`). */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Claude session ids are UUIDs. They are interpolated into the shell command
 * string used to spawn the CLI, so a value carrying shell metacharacters (from
 * a poisoned tmux sidecar or persisted session state) would be code execution.
 * Restrict to the UUID-safe alphabet.
 */
function isValidClaudeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

/**
 * Build the `--settings` argument that wires Claude Code lifecycle hooks to two
 * per-session files: a state word file owned by agent-state-manager, and a
 * notification event log owned by agent-event-manager. Returns a fully
 * shell-quoted token ready to drop into the `zsh -lc '<cmd>'` command string,
 * or null on Windows (hooks use POSIX `printf`/`grep`/`cat`; the app ships macOS-only).
 *
 * State words written: idle (start), working (prompt/tool activity), blocked
 * (permission/elicitation prompt), done (turn complete), ended (session end).
 *
 * The Notification event carries the payload the user actually needs to see
 * ("Claude is waiting for your input", "Claude needs your permission to use
 * Bash"), so a second hook on that event appends the raw hook stdin verbatim to
 * `<userData>/agent-events/<claveSessionId>.jsonl`. Verified against CC 2.1.233:
 * each hook command in a group is spawned with its own copy of the payload on
 * stdin, so the `grep` above and the `cat` here both see the full record; and CC
 * writes that payload as compact single-line JSON with one trailing newline, so
 * `cat >>` produces valid JSONL. No `matcher` is set, so every notification type
 * is captured and the filtering happens in agent-event-manager where unknown
 * types can be handled deliberately.
 *
 * `--settings` merges with (never replaces) the user's own settings.
 */
function buildClaudeHookSettingsArg(claveSessionId: string): string | null {
  if (isWindows) return null
  const statePath = stateFilePath(claveSessionId)
  const q = JSON.stringify(statePath) // double-quoted shell token for the path
  // Recreate the parent dir on every write: the hook path is baked in at spawn,
  // so a vanished userData dir (cleanup script, manual delete) must not turn
  // every lifecycle hook into a visible "No such file or directory" error.
  const qDir = JSON.stringify(path.dirname(statePath))
  const eventsPath = eventFilePath(claveSessionId)
  const qEvents = JSON.stringify(eventsPath)
  const qEventsDir = JSON.stringify(path.dirname(eventsPath))
  const write = (word: string): { hooks: { type: 'command'; command: string }[] } => ({
    hooks: [{ type: 'command', command: `mkdir -p ${qDir} && printf ${word} > ${q}` }]
  })
  const settings = {
    hooks: {
      // SessionStart also archives its payload: it names the CC session id and
      // transcript path, and it fires again with fresh values when /clear or a
      // resume rotates them. chat-manager tails the transcript and this is how
      // it follows the file. (Notification payloads land in the same log below.)
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: `mkdir -p ${qDir} && printf idle > ${q}` },
            { type: 'command', command: `mkdir -p ${qEventsDir} && cat >> ${qEvents} || true` }
          ]
        }
      ],
      UserPromptSubmit: [write('working')],
      PreToolUse: [write('working')],
      PostToolUse: [write('working')],
      // Notification fires for both permission prompts and ~60s idle. Only the
      // permission/elicitation case is a real "blocked" for the sidebar dot;
      // match the payload text (robust to the exact field name) and ignore the
      // idle case. The second command keeps the whole payload for the notifier.
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: `grep -qiE "permission|elicitation" && mkdir -p ${qDir} && printf blocked > ${q} || true`
            },
            {
              type: 'command',
              command: `mkdir -p ${qEventsDir} && cat >> ${qEvents} || true`
            }
          ]
        }
      ],
      Stop: [write('done')],
      SessionEnd: [write('ended')]
    }
  }
  return shellSingleQuote(JSON.stringify(settings))
}

let loginShellEnv: Record<string, string> | null = null

export function getUserShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

function parseEnvOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of output.split('\0')) {
    const idx = entry.indexOf('=')
    if (idx > 0) {
      env[entry.slice(0, idx)] = entry.slice(idx + 1)
    }
  }
  return env
}

/**
 * Pre-cache the login shell environment asynchronously.
 * On Windows, we just use the current process env (no login shell concept).
 * On macOS/Linux, call the login shell so that PATH and other vars are populated.
 */
export function preloadLoginShellEnv(): void {
  if (loginShellEnv !== null) return

  if (isWindows) {
    loginShellEnv = { ...process.env } as Record<string, string>
    return
  }

  execFile(getUserShell(), ['-lic', 'env -0'], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  }, (err, stdout) => {
    if (loginShellEnv !== null) return // already set by sync fallback
    if (err) {
      loginShellEnv = { ...process.env } as Record<string, string>
      return
    }
    const env = parseEnvOutput(stdout)
    loginShellEnv = Object.keys(env).length > 0 ? env : { ...process.env } as Record<string, string>
  })
}

export function getLoginShellEnv(): Record<string, string> {
  if (loginShellEnv !== null) return loginShellEnv

  if (isWindows) {
    loginShellEnv = { ...process.env } as Record<string, string>
    return loginShellEnv
  }

  // Sync fallback if async preload hasn't finished yet
  try {
    const output = execFileSync(getUserShell(), ['-lic', 'env -0'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    })
    const env = parseEnvOutput(output)
    loginShellEnv = Object.keys(env).length > 0 ? env : { ...process.env } as Record<string, string>
  } catch {
    loginShellEnv = { ...process.env } as Record<string, string>
  }
  return loginShellEnv
}

// ---------------------------------------------------------------------------
// tmux integration (opt-in, macOS/Linux)
//
// When enabled, a session's agent runs *inside* a named tmux session. The
// node-pty process is merely the tmux client; the agent lives in the tmux
// server (a daemon), so it survives the client dying — i.e. the app quitting
// or crashing. Re-opening the same session slot reattaches the live process,
// and it can also be reached from any terminal via `tmux -L clave attach`.
// ---------------------------------------------------------------------------

/** Dedicated tmux socket so Clave's sessions never collide with the user's
 *  default tmux server (and a stray `tmux kill-server` can't nuke their work). */
export const TMUX_SOCKET = 'clave'

/** Terminal interrogation sequences that may sit in a session's recorded
 *  output: DSR/CPR (`CSI n`, `CSI 6 n`), device attributes (`CSI c`,
 *  `CSI > c`, `CSI = c`), XTVERSION (`CSI > q`), XTWINOPS size queries
 *  (`CSI 14/16/18/19/20/21 t`), DECRQM mode probes (`CSI ? Pm $ p`), the
 *  kitty keyboard probe (`CSI ? u`), and OSC color queries (`OSC 10/11/4 ;?`).
 *  Replaying them into a fresh terminal makes it answer questions nobody is
 *  asking anymore; see replayTo. Responses are untouched — they only ever
 *  travel the other direction, so they never appear in recorded output. */
const REPLAYED_QUERY_SEQUENCES = new RegExp(
  [
    '\\x1b\\[\\??\\d*n', // DSR / CPR queries (5n, 6n, ?6n…)
    '\\x1b\\[(?:>|=)?0?c', // DA1 / DA2 / DA3 queries
    '\\x1b\\[>0?q', // XTVERSION query
    '\\x1b\\[(?:1[4689]|2[01])t', // XTWINOPS size queries
    '\\x1b\\[\\?\\d+\\$p', // DECRQM mode probes
    '\\x1b\\[\\?u', // kitty keyboard probe
    '\\x1b\\](?:1[01]|4;\\d+);\\?(?:\\x07|\\x1b\\\\)' // OSC color queries
  ].join('|'),
  'g'
)

// undefined = not probed yet, null = tmux not installed, string = absolute path
let tmuxPathCache: string | null | undefined
let tmuxConfigPathCache: string | null = null

/** Resolve tmux against the *login* shell PATH (Homebrew lives in /opt/homebrew
 *  which is usually absent from Electron's process.env.PATH). Uses the already
 *  preloaded login-shell env instead of spawning another `-lic` shell, so it
 *  doesn't block the main thread on the user's rc files. */
export function detectTmux(): string | null {
  if (tmuxPathCache !== undefined) return tmuxPathCache
  if (isWindows) {
    tmuxPathCache = null
    return null
  }
  const env = getLoginShellEnv()
  const pathDirs = (env.PATH || process.env.PATH || '').split(':')
  for (const dir of pathDirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'tmux')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      tmuxPathCache = candidate
      return candidate
    } catch {
      // not here, keep looking
    }
  }
  tmuxPathCache = null
  return null
}

export function isTmuxAvailable(): boolean {
  return detectTmux() !== null
}

/** Minimal, predictable config for embedded agent terminals. Passed via `-f`
 *  so the user's ~/.tmux.conf can't change behaviour (no surprise keybindings,
 *  no `destroy-unattached on` killing our sessions, no status bar stealing a
 *  row). Truecolor is forwarded and ESC latency dropped for snappy TUIs. */
export function getTmuxConfigPath(): string {
  if (tmuxConfigPathCache) return tmuxConfigPathCache
  const conf = [
    'set -g default-terminal "tmux-256color"',
    'set -as terminal-features ",xterm-256color:RGB"',
    'set -g destroy-unattached off',
    'set -g status off',
    'set -g history-limit 50000',
    'set -sg escape-time 10',
    'set -g focus-events on',
    // Mouse on, but with scrollback wiring: a bare `set -g mouse on` makes the
    // wheel send arrow keys to the shell (it mangles the prompt). Instead, the
    // wheel scrolls tmux's scrollback (entering copy-mode) unless the app inside
    // the pane wants the mouse itself (#{mouse_any_flag}), in which case we pass
    // the event through. Drag copies the selection to the macOS clipboard; scroll
    // back down (or finishing a selection) returns to the live prompt. We do NOT
    // bind MouseDown1Pane to cancel: the press fires before the drag, so canceling
    // on it jumps to the bottom and makes highlighting scrollback text impossible.
    'set -g mouse on',
    'bind -n WheelUpPane if -Ft= "#{mouse_any_flag}" "send -M" "if -Ft= \'#{pane_in_mode}\' \'send -X -N 3 scroll-up\' \'copy-mode -e\'"',
    'bind -n WheelDownPane if -Ft= "#{mouse_any_flag}" "send -M" "if -Ft= \'#{pane_in_mode}\' \'send -X -N 3 scroll-down\' \'send -M\'"',
    'bind -T copy-mode    MouseDragEnd1Pane send -X copy-pipe-and-cancel pbcopy',
    'bind -T copy-mode-vi MouseDragEnd1Pane send -X copy-pipe-and-cancel pbcopy',
    // If a second client (e.g. an external `tmux attach`) joins, follow the
    // most-recently-active client's size instead of shrinking to the smallest.
    'set -g window-size latest',
    // Let the agent's OSC notification and progress sequences reach the outer
    // terminal instead of being swallowed by tmux.
    'set -g allow-passthrough on',
    // Extended keys make modified keys (Shift+Enter above all) distinguishable
    // at the tmux layer, which is what Anthropic's terminal-config docs ask for.
    'set -s extended-keys on',
    "set -as terminal-features 'xterm*:extkeys'",
    ''
  ].join('\n')
  const p = path.join(app.getPath('userData'), 'clave.tmux.conf')
  try {
    fs.writeFileSync(p, conf, 'utf-8')
    tmuxConfigPathCache = p
  } catch {
    // Fall back to running without a config file rather than failing the spawn.
    return ''
  }
  return tmuxConfigPathCache
}

function agentModeTag(options?: PtySpawnOptions): string {
  if (options?.antigravityMode) return 'antigravity'
  if (options?.codexMode) return 'codex'
  if (options?.claudeAgentsMode) return 'agents'
  if (options?.claudeMode === false) return 'shell'
  return 'claude'
}

/** Tiny stable hash (djb2) → base36, so the same session slot maps to the same
 *  tmux session name across app restarts (enabling reattach on re-open). */
function shortHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i)
  }
  return (h >>> 0).toString(36).slice(0, 6)
}

/** Deterministic, human-readable, tmux-legal session name (no `.` or `:`). */
function baseTmuxName(cwd: string, modeTag: string): string {
  const folder = (cwd.split('/').pop() || 'clave')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 24)
  return `clave-${folder}-${shortHash(`${cwd}|${modeTag}`)}`
}

// --- Sidecar metadata + orphan management -------------------------------------
//
// tmux sessions outlive the app, so the tmux server itself is our source of
// truth for "what was running". For each tmux-backed session we drop a tiny
// JSON sidecar describing how to recreate its tab. On launch the renderer asks
// for the adoptable list: we cross-check sidecars against the live tmux server,
// hand back the survivors (to be reattached as tabs), prune sidecars whose
// session is gone, and reap any stray `clave-*` session that has no sidecar —
// so nothing can pile up invisibly.

/** Provenance of a session's tab name. Mirrors the renderer's SessionNameSource
 *  (`src/renderer/src/store/session-types.ts`); main can't import from there. */
export type SessionNameSource = 'auto' | 'preset' | 'user'

/** What the renderer needs to recreate + reattach a surviving session's tab. */
export interface AdoptableTmuxSession {
  tmuxName: string
  /** Original PTY session id, reused on adoption so the Claude lifecycle-hook
   *  state file (keyed by this id) keeps matching after reattach. */
  id: string
  claudeSessionId?: string
  cwd: string
  folderName: string
  /** The tab label as the user sees it — a manual rename or an auto-generated
   *  title. Absent means the tab still shows `folderName`. Kept in the sidecar
   *  (not just renderer memory) so a crash or reboot can't revert the name. */
  displayName?: string
  /** Where `displayName` came from: `'user'` (typed in the sidebar) protects it
   *  from the auto-title generator after re-adoption, `'preset'` (a `.clave`
   *  file, a pin, or an MCP call) and `'auto'` do not. Absent on sidecars
   *  written before this field existed — read `userRenamed` instead. */
  nameSource?: SessionNameSource
  /** Legacy mirror of `nameSource === 'user'`. Still written so a sidecar stays
   *  readable by an older Clave, and still read as the fallback for sidecars
   *  that predate `nameSource`. */
  userRenamed?: boolean
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  claudeAgentsMode: boolean
  dangerousMode: boolean
  /** Claude account/profile this session runs under, so the badge + config dir
   *  survive an app restart and re-adoption. */
  configDir?: string
  claudeProfileId?: string
  claudeProfileLabel?: string
  /** Populated only on the listAdoptableTmuxSessions() path (not persisted in
   *  the sidecar). True when the backing tmux session is still running (app
   *  quit/reopen, no reboot) → reattach to the live process. False when the
   *  tmux server died (e.g. a shutdown/reboot killed it) but the sidecar
   *  metadata survives → re-spawn fresh (Claude resumes via claudeSessionId). */
  live?: boolean
}

/** tmux session names we create are always `clave-<sanitized>`. Validate before
 *  using a name in a filesystem path or a kill-session call — it crosses the IPC
 *  boundary on the adoption/discard paths. */
export function isValidTmuxName(name: string): boolean {
  return /^clave-[A-Za-z0-9_-]+$/.test(name)
}

function tmuxSidecarDir(): string {
  return path.join(app.getPath('userData'), 'clave-tmux-sessions')
}

/** Persist restore metadata. Returns false if it couldn't be written, in which
 *  case the caller falls back to a non-tmux spawn so we never create a tmux
 *  session we can't track (and would later be unable to adopt or clean up). */
function writeTmuxSidecar(meta: AdoptableTmuxSession): boolean {
  if (!isValidTmuxName(meta.tmuxName)) return false
  try {
    const dir = tmuxSidecarDir()
    fs.mkdirSync(dir, { recursive: true })
    // Write-then-rename: sidecars are rewritten on every rename, so a kill
    // mid-write must never be able to leave a truncated file behind — that
    // would lose the whole session, not just its name.
    const target = path.join(dir, `${meta.tmuxName}.json`)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(meta), 'utf-8')
    fs.renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

function readTmuxSidecar(tmuxName: string): AdoptableTmuxSession | null {
  if (!isValidTmuxName(tmuxName)) return null
  try {
    return JSON.parse(
      fs.readFileSync(path.join(tmuxSidecarDir(), `${tmuxName}.json`), 'utf-8')
    ) as AdoptableTmuxSession
  } catch {
    return null
  }
}

/** Read a sidecar's name provenance. Sidecars written before `nameSource`
 *  existed carry only the `userRenamed` boolean, so map that forward. */
function sidecarNameSource(meta: AdoptableTmuxSession): SessionNameSource {
  if (meta.nameSource === 'auto' || meta.nameSource === 'preset' || meta.nameSource === 'user') {
    return meta.nameSource
  }
  return meta.userRenamed === true ? 'user' : 'auto'
}

function deleteTmuxSidecar(tmuxName: string): void {
  if (!isValidTmuxName(tmuxName)) return
  try {
    fs.unlinkSync(path.join(tmuxSidecarDir(), `${tmuxName}.json`))
  } catch {
    // already gone
  }
}

/** The tmux config (`-f`) is read only when the server *first* starts. Clave's
 *  sessions outlive the app, so a server from before a config change keeps the
 *  old key bindings. For bindings we've *removed* from the config, omission
 *  can't unset them on a live server — reconcile them explicitly here. No-op
 *  when no server is running: the fresh server loads the current config via -f.
 *  (Starting a server here would race that load, so we only touch a live one.) */
function reconcileTmuxBindings(tmuxPath: string): void {
  if (liveTmuxSessions(tmuxPath).size === 0) return
  // A live server was started by an earlier Clave and is still running the
  // config it booted with — "an adopted session scrolls differently or does
  // not scroll at all" is what that looks like from the outside. Re-apply the
  // SCROLL-related pieces of the config individually.
  //
  // Deliberately NOT `source-file`: the full config carries default-terminal,
  // terminal-features, and extended-keys, and re-applying those to a live
  // server makes tmux re-run client feature detection — it re-interrogates
  // every attached client (DA1/DA2/XTVERSION/size), the emulators answer, and
  // any reply landing after tmux's detection window is forwarded into the
  // pane as keystrokes. That is the "?65;4;…c >|SwiftTerm…" garbage typed
  // into every session's input line.
  const scrollCommands: string[][] = [
    ['set', '-g', 'mouse', 'on'],
    ['set', '-g', 'window-size', 'latest'],
    ['set', '-g', 'history-limit', '50000'],
    [
      'bind',
      '-n',
      'WheelUpPane',
      'if',
      '-Ft=',
      '#{mouse_any_flag}',
      'send -M',
      "if -Ft= '#{pane_in_mode}' 'send -X -N 3 scroll-up' 'copy-mode -e'"
    ],
    [
      'bind',
      '-n',
      'WheelDownPane',
      'if',
      '-Ft=',
      '#{mouse_any_flag}',
      'send -M',
      "if -Ft= '#{pane_in_mode}' 'send -X -N 3 scroll-down' 'send -M'"
    ],
    ['bind', '-T', 'copy-mode', 'MouseDragEnd1Pane', 'send', '-X', 'copy-pipe-and-cancel', 'pbcopy'],
    [
      'bind',
      '-T',
      'copy-mode-vi',
      'MouseDragEnd1Pane',
      'send',
      '-X',
      'copy-pipe-and-cancel',
      'pbcopy'
    ]
  ]
  for (const args of scrollCommands) {
    try {
      execFileSync(tmuxPath, ['-L', TMUX_SOCKET, ...args], { stdio: 'ignore' })
    } catch {
      // Best effort — a failed set leaves the server as it was.
    }
  }
  // Drop the legacy `MouseDown1Pane -> cancel` binding: the press fires before
  // the drag, so it snapped scrollback to the bottom on click and made
  // highlighting impossible. Without it, copy-mode's default drag-select works.
  // (Explicit because omission from the config can't unset a live binding.)
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    try {
      execFileSync(tmuxPath, ['-L', TMUX_SOCKET, 'unbind', '-T', table, 'MouseDown1Pane'], {
        stdio: 'ignore'
      })
    } catch {
      // Best effort — the binding is already absent on a fresh-enough server.
    }
  }
}

/** List live tmux sessions on the clave socket (empty if tmux/socket absent). */
function liveTmuxSessions(tmuxPath: string): Set<string> {
  try {
    const out = execFileSync(
      tmuxPath,
      ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf-8' }
    )
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    // No server running → no sessions.
    return new Set()
  }
}

export interface PtySpawnOptions {
  dangerousMode?: boolean
  claudeMode?: boolean
  antigravityMode?: boolean
  codexMode?: boolean
  claudeAgentsMode?: boolean
  resumeSessionId?: string
  claudeSessionId?: string
  initialCommand?: string
  autoExecute?: boolean
  /** Initial prompt handed to the agent CLI's interactive mode (claude/codex
   *  positional arg, agy -i). One-shot: not persisted to the tmux sidecar,
   *  so adoption re-spawns never re-submit it. */
  initialPrompt?: string
  /** Opt-in: run this session inside a persistent tmux session. */
  tmuxMode?: boolean
  /** Expose Clave's own MCP server to this session. Defaults to on; set false
   *  to spawn without `--mcp-config`, so the agent gets no clave_* tools. */
  claveMcp?: boolean
  /** Reattach to this exact existing tmux session instead of deriving a new
   *  name. Set when adopting a session that survived a previous app run. */
  adoptTmuxName?: string
  /** Reuse this exact PTY session id (instead of a fresh UUID) when adopting,
   *  so the Claude lifecycle-hook state file keeps matching the live agent. */
  adoptSessionId?: string
  /** CLAUDE_CONFIG_DIR for this session — selects the Claude account/profile.
   *  Empty/undefined leaves the env untouched (default passthrough). */
  configDir?: string
  /** Profile metadata persisted for restore + the session-header badge. */
  claudeProfileId?: string
  claudeProfileLabel?: string
}

interface PendingSpawn {
  file: string
  args: string[]
  cwd: string
  initialCommand?: string
  autoExecute?: boolean
  /** CLAUDE_CONFIG_DIR to set on the spawn env (account/profile selection). */
  configDir?: string
}

export interface PtySession {
  id: string
  cwd: string
  folderName: string
  ptyProcess: pty.IPty | null
  alive: boolean
  /** The tab label as the user sees it, mirrored from the renderer on every
   *  rename (see setSessionDisplayName). Undefined means the tab still shows
   *  `folderName`. Main needs this to title notifications it raises itself. */
  displayName?: string
  claudeSessionId?: string
  /** Set when this session is backed by a tmux session (the tmux session name). */
  tmuxName?: string
  /** True for a `claude` session (drives the bracketed-paste replay preamble). */
  claudeMode?: boolean
  /** True for any agent CLI session (claude/agy/codex/claude-agents). A plain
   *  terminal is the only kind the command-title poller renames. */
  agentMode?: boolean
  /** The tty of the tmux pane, resolved lazily by the command-title poller. */
  paneTty?: string | null
  /** The last command title the poller pushed, to send only real changes. */
  lastCommandTitle?: string
  pending?: PendingSpawn
  onData?: (data: string) => void
  onExit?: (exitCode: number) => void
  /** Bounded tail of this session's output, replayed to any terminal that is
   *  created after the pty is already running. See pty-replay.ts. */
  replay?: PtyReplayBuffer
}

class PtyManager {
  private sessions = new Map<string, PtySession>()

  /**
   * Plan a PTY spawn but defer the actual `pty.spawn()` until the renderer
   * has fit its xterm and reported real cols/rows. This avoids the TUI
   * (claude/agy) being born at the default 80×24 and then being mangled
   * by xterm's reflow when the renderer resizes to the real width.
   *
   * `start(id, cols, rows)` finalises the spawn at the correct size.
   */
  spawn(cwd: string, options?: PtySpawnOptions): PtySession {
    // Reuse the original id when adopting a survivor, so the Claude hook state
    // file (baked with this id at first spawn) still routes to this tab.
    const id =
      options?.adoptSessionId && options?.adoptTmuxName ? options.adoptSessionId : randomUUID()
    const folderName = (isWindows ? cwd.split('\\') : cwd.split('/')).pop() || cwd
    const useAgentsMode = options?.claudeAgentsMode === true
    const useAntigravityMode = options?.antigravityMode === true
    const useCodexMode = options?.codexMode === true
    const useClaudeMode = options?.claudeMode !== false && !useAntigravityMode && !useCodexMode && !useAgentsMode

    let claudeSessionId: string | undefined
    let shellArgs: string[]
    if (isWindows) {
      // Windows: cmd.exe with /c to exec the command directly (no echoed prompt).
      if (useAntigravityMode) {
        shellArgs = ['/c', 'agy']
      } else if (useCodexMode) {
        shellArgs = ['/c', 'codex']
      } else if (useAgentsMode) {
        // `claude agents` is an interactive subcommand and does not accept
        // --session-id / --resume / --dangerously-skip-permissions, so spawn it bare.
        shellArgs = ['/c', 'claude', 'agents']
      } else if (!useClaudeMode) {
        shellArgs = []
      } else {
        const parts = ['claude']
        if (options?.resumeSessionId) {
          if (!isValidClaudeSessionId(options.resumeSessionId)) {
            throw new Error('Invalid resume session id')
          }
          parts.push('--resume', options.resumeSessionId)
          claudeSessionId = options.resumeSessionId
        } else {
          const requested = options?.claudeSessionId
          claudeSessionId = requested && isValidClaudeSessionId(requested) ? requested : randomUUID()
          parts.push('--session-id', claudeSessionId)
        }
        if (options?.dangerousMode) parts.push('--dangerously-skip-permissions')
        shellArgs = ['/c', ...parts]
      }
    } else {
      // POSIX: -l -c '<cmd>' runs the command non-interactively (no echo, no
      // prompt, no rc-file chatter like the macOS bash→zsh notice).
      if (useAntigravityMode) {
        shellArgs = [
          '-l',
          '-c',
          options?.initialPrompt
            ? `agy -i ${shellSingleQuote(options.initialPrompt)}`
            : 'agy'
        ]
      } else if (useCodexMode) {
        shellArgs = [
          '-l',
          '-c',
          options?.initialPrompt ? `codex ${shellSingleQuote(options.initialPrompt)}` : 'codex'
        ]
      } else if (useAgentsMode) {
        // `claude agents` is an interactive subcommand and does not accept
        // --session-id / --resume / --dangerously-skip-permissions, so spawn it bare.
        shellArgs = ['-l', '-c', 'claude agents']
      } else if (!useClaudeMode) {
        shellArgs = ['-l']
      } else {
        const parts = ['claude']
        if (options?.resumeSessionId) {
          // Interpolated into the `zsh -l -c` string below — reject ids carrying
          // shell metacharacters (e.g. from a poisoned sidecar) rather than run them.
          if (!isValidClaudeSessionId(options.resumeSessionId)) {
            throw new Error('Invalid resume session id')
          }
          parts.push('--resume', options.resumeSessionId)
          claudeSessionId = options.resumeSessionId
        } else {
          const requested = options?.claudeSessionId
          claudeSessionId = requested && isValidClaudeSessionId(requested) ? requested : randomUUID()
          parts.push('--session-id', claudeSessionId)
        }
        if (options?.dangerousMode) parts.push('--dangerously-skip-permissions')
        // Wire lifecycle hooks → per-session state file for deterministic tab status.
        const settingsArg = buildClaudeHookSettingsArg(id)
        if (settingsArg) parts.push('--settings', settingsArg)
        // Wire the in-app MCP server so the agent can manipulate Clave (open
        // tabs, create groups). The config rides in a 0600 file rather than
        // inline JSON to keep the bearer token off ps/tmux-visible command lines.
        // Skipped entirely when the user turns the server off, so no config
        // file is written and the agent sees no clave_* tools at all.
        const mcpConfigPath =
          options?.claveMcp !== false && getMcpRuntime() ? writeSessionMcpConfig(id) : null
        if (mcpConfigPath) parts.push('--mcp-config', shellSingleQuote(mcpConfigPath))
        // Initial prompt goes LAST after a `--` separator. `--` ends the
        // variadic --mcp-config (so the prompt isn't read as another config
        // path) AND stops a prompt that begins with `-` from being parsed as a
        // flag. Verified: `claude <flags> --mcp-config F -- '<prompt>'`.
        if (options?.initialPrompt) parts.push('--', shellSingleQuote(options.initialPrompt))
        // CLAVE_SESSION_ID rides inside the command string, not the pty env: when
        // a tmux server already exists, new-session inherits the server's
        // environment, so only the command string reliably reaches claude.
        shellArgs = ['-l', '-c', `CLAVE_SESSION_ID=${shellSingleQuote(id)} ${parts.join(' ')}`]
      }
    }

    // By default we spawn the user's shell directly. When tmux mode is opted in
    // (and tmux is installed), we instead spawn a tmux client that runs the very
    // same shell command inside a persistent, named tmux session.
    const shellName = getUserShell()
    let spawnFile = shellName
    let spawnArgs = shellArgs
    let tmuxName: string | undefined
    let adoptedDisplayName: string | undefined

    const tmuxPath = options?.tmuxMode ? detectTmux() : null
    if (tmuxPath) {
      // When adopting a survivor, reattach to its exact (validated) name;
      // otherwise derive a fresh name that doesn't clash with any live session.
      const adopt = options?.adoptTmuxName
      const candidateName =
        adopt && isValidTmuxName(adopt) ? adopt : this.uniqueTmuxName(cwd, agentModeTag(options))

      // Adoption rewrites the sidecar from scratch, so carry the tab's name
      // forward — otherwise re-adopting a session would erase the very name we
      // persisted for it and the next crash would show the folder name again.
      const previous = adopt ? readTmuxSidecar(candidateName) : null
      adoptedDisplayName = previous?.displayName

      // Persist restore metadata first. If we can't track the session, fall back
      // to a plain shell spawn rather than create an untrackable tmux session.
      const sidecarOk = writeTmuxSidecar({
        tmuxName: candidateName,
        displayName: previous?.displayName,
        nameSource: previous ? sidecarNameSource(previous) : undefined,
        userRenamed: previous ? sidecarNameSource(previous) === 'user' : undefined,
        id,
        claudeSessionId,
        cwd,
        folderName,
        claudeMode: useClaudeMode,
        antigravityMode: useAntigravityMode,
        codexMode: useCodexMode,
        claudeAgentsMode: useAgentsMode,
        dangerousMode: options?.dangerousMode === true,
        configDir: options?.configDir,
        claudeProfileId: options?.claudeProfileId,
        claudeProfileLabel: options?.claudeProfileLabel
      })

      if (sidecarOk) {
        tmuxName = candidateName
        const confPath = getTmuxConfigPath()
        // A server predating this fix still carries the old click-to-cancel
        // binding; strip it from the live server so the fix applies without a
        // server restart (the -f config below only takes effect on a new one).
        reconcileTmuxBindings(tmuxPath)
        // `-u` forces UTF-8 client output. Electron apps are launched without a
        // UTF-8 locale (no LANG/LC_* in the GUI environment), so tmux would
        // otherwise run the client in non-UTF-8 mode and downsample every
        // multibyte glyph — box-drawing, the agent's logo, em-dashes — to `_`.
        // (Direct, non-tmux PTYs are unaffected: the agent + xterm.js are always
        // UTF-8; only tmux gates UTF-8 on the locale env.)
        const tmuxArgs: string[] = ['-u', '-L', TMUX_SOCKET]
        if (confPath) tmuxArgs.push('-f', confPath)
        // `new-session -A`: attach if the session already exists (reattach a live
        // agent after an app restart / from elsewhere), otherwise create it and
        // run the shell command. Attaching never re-runs the command. Fresh names
        // are guaranteed not to collide with a survivor, so `-A` only reattaches
        // on the explicit adoption path.
        tmuxArgs.push('new-session', '-A', '-s', tmuxName, shellName, ...shellArgs)
        spawnFile = tmuxPath
        spawnArgs = tmuxArgs
      }
    }

    const session: PtySession = {
      id,
      cwd,
      folderName,
      ptyProcess: null,
      alive: true,
      pending: {
        file: spawnFile,
        args: spawnArgs,
        cwd,
        initialCommand: options?.initialCommand,
        autoExecute: options?.autoExecute,
        configDir: options?.configDir
      }
    }
    if (claudeSessionId) session.claudeSessionId = claudeSessionId
    if (tmuxName) session.tmuxName = tmuxName
    session.claudeMode = useClaudeMode
    session.agentMode = useClaudeMode || useAntigravityMode || useCodexMode || useAgentsMode
    // Adoption restores the tab under its persisted name, so carry it into the
    // in-memory record too — otherwise main would title notifications for a
    // re-adopted tab with the folder name until the next rename.
    if (adoptedDisplayName) session.displayName = adoptedDisplayName
    this.sessions.set(id, session)
    return session
  }

  /** Pick a fresh tmux session name that clashes with neither an in-process
   *  session nor a live session on the tmux server. Checking the server too is
   *  essential: it stops a brand-new session from silently `-A`-attaching to a
   *  not-yet-adopted survivor of the same cwd+mode (which would hijack it). */
  private uniqueTmuxName(cwd: string, modeTag: string): string {
    const base = baseTmuxName(cwd, modeTag)
    const taken = new Set(
      Array.from(this.sessions.values())
        .map((s) => s.tmuxName)
        .filter((n): n is string => !!n)
    )
    const tmuxPath = detectTmux()
    if (tmuxPath) for (const n of liveTmuxSessions(tmuxPath)) taken.add(n)
    if (!taken.has(base)) return base
    let n = 2
    while (taken.has(`${base}-${n}`)) n++
    return `${base}-${n}`
  }

  /**
   * Register the data/exit listeners that should be wired up as soon as the
   * underlying pty.spawn() runs. Must be called BEFORE start().
   */
  attachListeners(
    id: string,
    onData: (data: string) => void,
    onExit: (exitCode: number) => void
  ): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.onData = onData
    session.onExit = onExit
  }

  /**
   * Actually spawn the PTY at the renderer-measured cols/rows. Safe to call
   * once per session id; subsequent calls just resize.
   */
  start(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.ptyProcess) {
      // The pty is already running, so the caller is a *newly created, empty*
      // xterm for a session that has been printing for a while — the renderer
      // only sends pty:start once per terminal instance, before any data can
      // reach it. Resizing alone can't fill it in: the grid is almost always
      // the size the pty already has, and a no-op winsize change raises no
      // SIGWINCH, so tmux and the agent TUIs have no reason to redraw. Without
      // the replay the tab stays blank behind a blinking cursor until the agent
      // prints something unprompted, which for an idle session may be never.
      if (session.alive) {
        this.replayTo(session)
        const c = Math.max(1, cols)
        const r = Math.max(1, rows)
        const proc = session.ptyProcess
        const sameSize = proc.cols === c && proc.rows === r
        proc.resize(c, r)
        if (sameSize && session.tmuxName) {
          // Same-size reattach: the kernel drops a no-op winsize change, so no
          // SIGWINCH lands and nothing repaints — the replayed tail (bounded,
          // and laid out for whenever it was captured) would be all this
          // terminal ever shows. `refresh-client` makes tmux repaint OUR
          // client without touching the pane. A resize jog would repaint too,
          // but its SIGWINCH makes agent TUIs re-interrogate the terminal, and
          // with a second client attached (the iPad) the duplicate replies
          // come back as typed garbage.
          this.refreshTmuxClient(session)
        }
      }
      return
    }
    if (!session.pending) return
    const { file, args, cwd, initialCommand, autoExecute, configDir } = session.pending
    session.pending = undefined

    const ptyName = isWindows ? undefined : 'xterm-256color'

    const ptyProcess = pty.spawn(file, args, {
      name: ptyName,
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      cwd,
      env: (() => {
        const env: Record<string, string> = {
          ...getLoginShellEnv(),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
        delete env.CLAUDECODE
        // Per-session Claude account: point this session at an alternate config
        // dir. Only set when a non-default profile was chosen, so default
        // sessions keep honouring whatever the shell already exports.
        if (configDir) env.CLAUDE_CONFIG_DIR = configDir
        return env
      })()
    })

    session.ptyProcess = ptyProcess
    session.replay = new PtyReplayBuffer()

    // node-pty delivers these from a worker thread through a N-API
    // ThreadSafeFunction, and a JS exception thrown back out of that callback is
    // rethrown as an uncaught C++ exception — which aborts the whole process,
    // every other session with it. (Seen for real: a SIGTERM during teardown
    // left `win.webContents` destroyed while data was still arriving, the send
    // threw, and Electron died with SIGABRT inside pty.node's CallJS.) Nothing
    // downstream of a pty read is important enough to take the app down, so the
    // handoff is wrapped here — at the one boundary node-pty actually calls —
    // rather than trusting every current and future listener to be total.
    ptyProcess.onData((data) => {
      session.replay?.append(data)
      try {
        session.onData?.(data)
      } catch (err) {
        console.error(`[pty] data handler threw for session ${id}`, err)
      }
    })
    ptyProcess.onExit(({ exitCode }) => {
      session.alive = false
      // A dead session can't be repainted, and the tab shows "[Session ended]".
      session.replay?.clear()
      session.replay = undefined
      try {
        session.onExit?.(exitCode)
      } catch (err) {
        console.error(`[pty] exit handler threw for session ${id}`, err)
      }
    })

    // For plain-shell mode (no claude/agy), honour an explicit initialCommand.
    if (initialCommand) {
      setTimeout(() => {
        if (session.alive && session.ptyProcess) {
          session.ptyProcess.write(autoExecute === true ? initialCommand + '\r' : initialCommand)
        }
      }, INITIAL_COMMAND_DELAY_MS)
    }
  }

  /** Repaint a freshly created terminal from what the session has already
   *  printed. Goes out on the session's normal data channel because it *is* the
   *  session's output — the renderer's activity/prompt heuristics read the
   *  screen, and they should see the same screen a live attach would have
   *  produced.
   *
   *  The tail is prefixed with the DECSETs the session's previous terminal was
   *  put into when it attached. They were emitted exactly once — tmux enters
   *  the alternate screen and turns mouse reporting on when its client starts,
   *  claude enables bracketed paste at its prompt — so on a long-lived session
   *  they scrolled out of the bounded buffer long ago. A new xterm replayed
   *  without them lands in the normal buffer with a dead wheel: scrollback
   *  looks empty, the wheel never reaches tmux's WheelUpPane bindings, and
   *  "the session can't scroll" is the user-visible result. */
  private replayTo(session: PtySession): void {
    if (!session.onData) return
    let preamble = ''
    if (session.tmuxName) preamble += '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h'
    if (session.claudeMode) preamble += '\x1b[?2004h'
    const buffered = session.replay?.read() ?? ''
    // Strip terminal QUERIES from the tail. The recorded stream contains the
    // interrogations tmux and the agent CLIs sent to the ORIGINAL terminal
    // (device attributes, version, cell/pixel size, cursor position, mode
    // probes). A freshly created xterm auto-answers anything it is fed, those
    // answers go into the pty as input, and everything downstream already got
    // its answers long ago — so tmux forwards the stale replies into the pane
    // as keystrokes. That is the "?65;4;…c" garbage typed at the prompt.
    const payload = preamble + buffered.replace(REPLAYED_QUERY_SEQUENCES, '')
    if (!payload) return
    try {
      session.onData(payload)
    } catch (err) {
      console.error(`[pty] replay failed for session ${session.id}`, err)
    }
  }

  /** Force tmux to repaint this session's OWN client (the node-pty one — its
   *  pid is the tmux client process). Used on same-size reattach, where no
   *  SIGWINCH will fire; unlike a resize jog it involves neither the pane
   *  process nor any other attached client. */
  private refreshTmuxClient(session: PtySession): void {
    const tmuxPath = detectTmux()
    const pid = session.ptyProcess?.pid
    if (!tmuxPath || !session.tmuxName || !pid) return
    execFile(
      tmuxPath,
      ['-L', TMUX_SOCKET, 'list-clients', '-t', session.tmuxName, '-F', '#{client_pid}\t#{client_tty}'],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) return
        const line = stdout.split('\n').find((l) => l.startsWith(`${pid}\t`))
        const tty = line?.split('\t')[1]?.trim()
        if (!tty) return
        execFile(tmuxPath, ['-L', TMUX_SOCKET, 'refresh-client', '-t', tty], { timeout: 2000 }, () => {})
      }
    )
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.ptyProcess?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (!session.ptyProcess) {
      // Not yet started — promote first resize into start().
      this.start(id, cols, rows)
      return
    }
    if (session.alive) {
      session.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows))
    }
  }

  /**
   * Terminate a session.
   *
   * @param killTmuxSession when true (a user explicitly closing the session)
   *   the backing tmux session is destroyed for real. When false (the app is
   *   quitting) we only kill the local tmux *client*, which detaches and leaves
   *   the agent running in the tmux server to be reattached next launch.
   */
  kill(id: string, killTmuxSession = true): void {
    const session = this.sessions.get(id)
    if (session) {
      if (session.tmuxName && killTmuxSession) {
        const tmuxPath = detectTmux()
        if (tmuxPath) {
          execFile(
            tmuxPath,
            ['-L', TMUX_SOCKET, 'kill-session', '-t', session.tmuxName],
            () => {}
          )
        }
        deleteTmuxSidecar(session.tmuxName)
      }
      // On a real close the session is gone for good; on app quit (tmux
      // survivor) the config must stay valid for the reattached agent.
      if (killTmuxSession) deleteSessionMcpConfig(id)
      if (session.alive && session.ptyProcess) {
        session.ptyProcess.kill()
      }
      session.replay = undefined
      this.sessions.delete(id)
    }
  }

  /**
   * Record the tab's display name in the session's tmux sidecar so it survives
   * an app restart, a crash, or a reboot. Renames live in the renderer store,
   * which dies with the window — the sidecar is the only per-session record
   * that outlives it. Called on every rename (manual, auto-title, or reset to
   * the folder name); a no-op for sessions with no tmux sidecar to update.
   *
   * `userRenamed` is written alongside `nameSource` so sidecars stay readable by
   * a Clave build that predates `nameSource`.
   */
  setSessionDisplayName(
    id: string,
    displayName: string | null,
    nameSource: SessionNameSource
  ): void {
    const session = this.sessions.get(id)
    const next = displayName?.trim() || undefined
    // Mirror into the in-memory record first: notifications raised by main
    // (agent-event-manager) are titled with the tab name, and that has to work
    // for non-tmux sessions too, which have no sidecar.
    if (session) session.displayName = next
    const tmuxName = session?.tmuxName
    if (!tmuxName) return
    const meta = readTmuxSidecar(tmuxName)
    if (!meta) return
    if (meta.displayName === next && sidecarNameSource(meta) === nameSource) return
    writeTmuxSidecar({
      ...meta,
      displayName: next,
      nameSource,
      userRenamed: nameSource === 'user'
    })
  }

  /**
   * The label to show for a session: its tab name, or the folder name when it
   * was never renamed. Returns null for an unknown id, which also serves as the
   * "is this session still tracked" check for notifications raised from main.
   */
  getSessionLabel(id: string): string | null {
    const session = this.sessions.get(id)
    if (!session) return null
    return session.displayName?.trim() || session.folderName
  }

  /** Live sessions the command-title poller may rename: plain terminals only.
   *  Agent sessions title themselves (transcript-based for Claude), and
   *  `agentMode === false` is deliberate — a session whose mode is unknown is
   *  left alone rather than renamed on a guess. */
  commandTitleCandidates(): PtySession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.alive && !!s.ptyProcess && s.agentMode === false
    )
  }

  /**
   * Reconcile sidecars with the live tmux server and return the sessions that
   * survived a previous run and should be brought back as tabs. Each is flagged
   * `live`:
   *   - `live: true`  → the tmux session is still running (app quit/reopen, no
   *     reboot). The caller reattaches to the live process.
   *   - `live: false` → the tmux server is gone (a shutdown/reboot killed it)
   *     but the sidecar survived on disk. The caller re-spawns the session fresh
   *     in the same cwd; Claude sessions resume their conversation via
   *     claudeSessionId. The agent's in-memory state is unrecoverable across a
   *     reboot, so a fresh spawn is the best we can do.
   *
   * We deliberately do NOT kill live sessions that lack a sidecar: the `clave`
   * socket is user-attachable (the settings panel advertises `tmux -L clave
   * attach`), so a name prefix isn't proof of ownership. Because every
   * Clave-created session is written a sidecar before it is spawned (and falls
   * back to a non-tmux spawn if that write fails), our own sessions are always
   * tracked. Sidecars are pruned only when malformed or when their cwd no longer
   * exists (un-restorable) — so they can't accumulate across reboots.
   */
  listAdoptableTmuxSessions(): AdoptableTmuxSession[] {
    const tmuxPath = detectTmux()
    if (!tmuxPath) return []

    const live = liveTmuxSessions(tmuxPath)
    const alreadyAdopted = new Set(
      Array.from(this.sessions.values())
        .map((s) => s.tmuxName)
        .filter((n): n is string => !!n)
    )

    const dir = tmuxSidecarDir()
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      files = []
    }

    const adoptable: AdoptableTmuxSession[] = []
    for (const file of files) {
      let meta: AdoptableTmuxSession | null = null
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      } catch {
        meta = null
      }
      if (meta && meta.antigravityMode === undefined) {
        // Legacy sidecars (written before the Antigravity switch) carry the old
        // `antigravityMode`'s predecessor key. Map it forward so a survivor of the
        // retired Gemini CLI re-spawns as Antigravity (`agy`) on adoption.
        meta.antigravityMode = (meta as { geminiMode?: boolean }).geminiMode ?? false
      }
      if (!meta?.tmuxName || !isValidTmuxName(meta.tmuxName)) {
        try {
          fs.unlinkSync(path.join(dir, file))
        } catch {
          /* ignore */
        }
        continue
      }
      const isLive = live.has(meta.tmuxName)
      if (!isLive && !fs.existsSync(meta.cwd)) {
        // The working directory is gone — the session can't be re-spawned, so
        // its sidecar is dead weight. Prune it.
        deleteTmuxSidecar(meta.tmuxName)
        continue
      }
      if (!alreadyAdopted.has(meta.tmuxName)) {
        adoptable.push({ ...meta, live: isLive })
      }
    }

    return adoptable
  }

  /** Destroy a surviving tmux session the user chose not to adopt. */
  discardTmuxSession(tmuxName: string): void {
    if (!isValidTmuxName(tmuxName)) return
    const tmuxPath = detectTmux()
    if (tmuxPath) {
      execFile(tmuxPath, ['-L', TMUX_SOCKET, 'kill-session', '-t', tmuxName], () => {})
    }
    deleteTmuxSidecar(tmuxName)
  }

  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id)
  }

  getAllSessions(): { id: string; cwd: string; folderName: string; alive: boolean }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      folderName: s.folderName,
      alive: s.alive
    }))
  }

  /**
   * Kill every session. Used on app quit: tmux-backed sessions are only
   * detached (not destroyed) so the agents survive until the next launch.
   */
  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id, false)
    }
  }
}

// Re-export the default constants so existing imports remain valid.
export { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS }

export const ptyManager = new PtyManager()
