import { execFile } from 'child_process'
import { BrowserWindow } from 'electron'
import { ptyManager, detectTmux, TMUX_SOCKET } from './pty-manager'

/**
 * Command-derived tab titles for plain terminal sessions.
 *
 * Claude sessions get their titles from the transcript (title-generator);
 * terminals had nothing, so every tab read as its folder name until the user
 * renamed it by hand. This poller titles them from what they are actually
 * doing: the foreground command of the pane ("npm run dev", "vim main.ts"),
 * kept as the *last* command once the shell is back at its prompt, so an idle
 * tab still says what it was for.
 *
 * Titles ride the existing `session:auto-title:<id>` channel, so they inherit
 * the renderer's rules for free: `autoRenameSession` never overwrites a name
 * the user typed, and the name persists through the tmux sidecar like any
 * other rename.
 *
 * Sources, in order of fidelity:
 *  - tmux sessions (the default): the pane's tty from `list-panes`, then one
 *    `ps -t` over every tracked tty per tick. The foreground row (`+` in
 *    STAT) carries the full argv, so the title shows arguments.
 *  - direct ptys: node-pty's `process`, which is the foreground process name
 *    only — no argv, but still better than a folder name.
 */

const POLL_MS = 3000
const TITLE_MAX = 30

/** Foreground names that mean "the shell itself is in charge": the session is
 *  idle, so the previous title (the last command) stands. */
const SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'login', 'tmux'])

let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

export function startCommandTitlePoller(): void {
  if (timer) return
  timer = setInterval(() => {
    if (inFlight) return
    inFlight = true
    void tick()
      .catch(() => {
        // A failed tick is a skipped tick; the next one re-derives everything.
      })
      .finally(() => {
        inFlight = false
      })
  }, POLL_MS)
}

export function stopCommandTitlePoller(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function tick(): Promise<void> {
  const candidates = ptyManager.commandTitleCandidates()
  if (candidates.length === 0) return

  const tmuxPath = detectTmux()
  const tmuxCandidates = candidates.filter((s) => s.tmuxName)
  if (tmuxPath && tmuxCandidates.some((s) => s.paneTty === undefined)) {
    const byName = await paneTtys(tmuxPath)
    for (const session of tmuxCandidates) {
      if (session.paneTty !== undefined) continue
      const tty = session.tmuxName ? byName.get(session.tmuxName) : undefined
      // Only successes are cached; a session tmux does not list yet is retried
      // on the next tick rather than written off.
      if (tty) session.paneTty = tty
    }
  }

  const ttys = tmuxCandidates
    .map((s) => s.paneTty)
    .filter((t): t is string => typeof t === 'string')
  const foreground = ttys.length > 0 ? await foregroundByTty(ttys) : new Map<string, string>()

  for (const session of candidates) {
    let title: string | null = null
    if (session.paneTty) {
      const args = foreground.get(session.paneTty)
      if (args) title = formatCommandTitle(args)
    } else if (!session.tmuxName && session.ptyProcess) {
      title = formatCommandTitle(session.ptyProcess.process)
    }
    if (!title || title === session.lastCommandTitle) continue
    session.lastCommandTitle = title
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(`session:auto-title:${session.id}`, title)
    }
  }
}

/** tmux session name -> pane tty (without the /dev/ prefix), one call for all. */
async function paneTtys(tmuxPath: string): Promise<Map<string, string>> {
  const out = await run(tmuxPath, [
    '-L',
    TMUX_SOCKET,
    'list-panes',
    '-a',
    '-F',
    '#{session_name}\t#{pane_tty}'
  ])
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    const [name, tty] = line.trim().split('\t')
    if (name && tty) map.set(name, tty.replace(/^\/dev\//, ''))
  }
  return map
}

/** tty -> full argv of its foreground process (lowest pid in the foreground
 *  group, so "npm run dev" wins over the node child it spawned). */
async function foregroundByTty(ttys: string[]): Promise<Map<string, string>> {
  const out = await run('/bin/ps', ['-o', 'stat=,tty=,pid=,args=', '-t', ttys.join(',')])
  const best = new Map<string, { pid: number; args: string }>()
  for (const line of out.split('\n')) {
    const match = /^\s*(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const [, stat, tty, pidRaw, args] = match
    if (!stat.includes('+')) continue
    const pid = Number(pidRaw)
    const current = best.get(tty)
    if (!current || pid < current.pid) best.set(tty, { pid, args })
  }
  return new Map(Array.from(best, ([tty, entry]) => [tty, entry.args]))
}

/** "VAR=x /usr/local/bin/npm run dev" -> "npm run dev"; a bare shell -> null. */
export function formatCommandTitle(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/)
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift()
  if (tokens.length === 0) return null
  let command = tokens[0].split('/').pop() ?? tokens[0]
  // Login shells report as "-zsh".
  if (command.startsWith('-')) command = command.slice(1)
  if (!command || SHELL_NAMES.has(command)) return null
  let title = [command, ...tokens.slice(1)].join(' ')
  if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX - 1) + '…'
  return title
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
