#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain node script, no TS annotations available */
/**
 * Behaviour lock for the two defects that made adopted sessions come up as an
 * empty grid behind a blinking cursor.
 *
 * The repo has no test runner (no vitest/jest config, no test files), so this is
 * a plain node script in the same shape as `verify-keymap.mjs`, wired as
 * `npm run verify:pty`.
 *
 * Part 1 — the replay tail (`src/main/pty-replay.ts`), pure and directly
 * testable: it must retain the recent output, trim from the *front* on whole
 * chunk boundaries (a mid-chunk cut would strand half an escape sequence at the
 * head of a repaint), and never trim itself down to nothing.
 *
 * Part 2 — the node-pty callback boundary, tested against real node-pty: a
 * listener that throws must be contained. Before the fix the exception escaped
 * back into pty.node's ThreadSafeFunction and aborted the whole process with
 * SIGABRT, taking every other session with it. The check runs in a child
 * process so an unfixed build fails as a non-zero exit rather than killing the
 * verifier itself.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { PtyReplayBuffer, REPLAY_LIMIT_BYTES } = await import(
  join(repoRoot, 'src', 'main', 'pty-replay.ts')
)

let failures = 0
function check(condition, message) {
  if (!condition) {
    failures++
    console.error(`  FAIL  ${message}`)
  } else {
    console.log(`  ok    ${message}`)
  }
}

console.log('replay tail')

{
  const buf = new PtyReplayBuffer()
  check(buf.read() === '', 'a session that has printed nothing replays nothing')
  buf.append('hello ')
  buf.append('world')
  check(buf.read() === 'hello world', 'retains output in order')
  check(buf.read() === 'hello world', 'reading twice yields the same tail')
}

{
  // The regression this exists for: a terminal created over an already-running
  // pty used to receive nothing at all, so it stayed blank forever.
  const buf = new PtyReplayBuffer()
  buf.append('\x1b[2J\x1b[H$ claude\r\n')
  check(buf.read().length > 0, 'an already-running session has something to repaint')
}

{
  const limit = 100
  const buf = new PtyReplayBuffer(limit)
  for (let i = 0; i < 50; i++) buf.append('0123456789')
  check(buf.byteLength <= limit, `trims to the ${limit}-byte cap (kept ${buf.byteLength})`)
  check(buf.read().endsWith('0123456789'), 'keeps the most recent output')
  check(buf.byteLength % 10 === 0, 'trims on whole chunk boundaries, never mid-chunk')
}

{
  // A single chunk larger than the cap must survive: repainting from an
  // oversized tail still beats repainting from nothing.
  const buf = new PtyReplayBuffer(10)
  buf.append('x'.repeat(500))
  check(buf.read().length === 500, 'never trims itself empty')
}

{
  const buf = new PtyReplayBuffer()
  buf.append('something')
  buf.clear()
  check(buf.read() === '' && buf.byteLength === 0, 'clear() releases the tail')
  check(REPLAY_LIMIT_BYTES > 64 * 1024, 'default cap holds at least a full-screen redraw')
}

console.log('node-pty callback containment')

// Both halves run in a child process, so the unguarded control's SIGABRT is
// observed rather than inherited by this script.
//
// `wrapped` mirrors the try/catch that pty-manager's start() puts around
// session.onData. The unguarded control exists to keep this honest: it proves
// the hazard is real on this node-pty build, so a future refactor that "tidies
// away" the try/catch fails here instead of shipping a one-throw app kill.
const probe = (wrapped) => `
import * as pty from 'node-pty'
const p = pty.spawn('/bin/sh', ['-c', 'echo hi; sleep 0.4'], { name: 'xterm-256color', cols: 80, rows: 24 })
// The failure mode this guards: the downstream consumer throws from inside
// node-pty's data callback (a webContents.send on a destroyed window does
// exactly this during teardown or a renderer reload).
const consumer = () => { throw new Error('boom') }
p.onData(() => {
  ${wrapped ? 'try { consumer() } catch { /* contained */ }' : 'consumer()'}
})
p.onExit(() => { console.log('SURVIVED'); process.exit(0) })
setTimeout(() => { console.log('SURVIVED'); process.exit(0) }, 3000)
`
const run = (wrapped) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', probe(wrapped)], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 15000
  })

const unguarded = run(false)
check(
  unguarded.status !== 0 || !/SURVIVED/.test(unguarded.stdout ?? ''),
  `control: an unguarded throw really does kill the process (status=${unguarded.status} signal=${unguarded.signal})`
)

const guarded = run(true)
check(guarded.signal !== 'SIGABRT', 'a throwing data consumer does not abort the process')
check(
  guarded.status === 0 && /SURVIVED/.test(guarded.stdout ?? ''),
  `the pty run completes (status=${guarded.status} signal=${guarded.signal})`
)

console.log('re-attach repaint (the symptom itself)')

// The defect end to end: a second terminal opened onto an already-running,
// currently-quiet session. `start()` used to answer that with a resize to the
// grid the pty already had — and the kernel raises no SIGWINCH for a winsize
// that did not change, so tmux never redrew and the tab stayed empty behind a
// blinking cursor. Runs on its own tmux socket so it can never see, resize, or
// kill a session belonging to the app.
const SOCKET = 'clave-verify-replay'
const SESSION = 'clave-verify-replay-1'
const tmuxAvailable = spawnSync('tmux', ['-V'], { encoding: 'utf-8' }).status === 0

if (!tmuxAvailable) {
  console.log('  skip  tmux not installed')
} else {
  const tmux = (...args) =>
    spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf-8', timeout: 10000 })
  tmux('kill-session', '-t', `=${SESSION}`)
  const scenario = `
import * as pty from 'node-pty'
const [socket, session] = [${JSON.stringify(SOCKET)}, ${JSON.stringify(SESSION)}]
const COLS = 100, ROWS = 30
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// A session that painted once and then went quiet — an idle agent TUI.
const attach = () => pty.spawn('tmux', ['-u', '-L', socket, 'new-session', '-A', '-s', session,
  '/bin/sh', '-c', 'printf "MARKER-PAINTED\\\\n"; sleep 30'],
  { name: 'xterm-256color', cols: COLS, rows: ROWS })

const p = attach()
let first = ''
p.onData((d) => { first += d })
await wait(2500)
if (!first.includes('MARKER-PAINTED')) { console.log('SETUP_FAILED'); process.exit(3) }

// Terminal #2 opens. Old start(): resize to the size the pty already has.
let afterResize = ''
p.onData((d) => { afterResize += d })
p.resize(COLS, ROWS)
await wait(1500)

console.log(JSON.stringify({
  repaintedByResize: afterResize.includes('MARKER-PAINTED'),
  bytesFromResize: afterResize.length,
  replayHasScreen: first.includes('MARKER-PAINTED')
}))
process.exit(0)
`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', scenario], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 40000
  })
  tmux('kill-session', '-t', `=${SESSION}`)
  const line = (out.stdout ?? '').trim().split('\n').pop() ?? ''
  let result = null
  try {
    result = JSON.parse(line)
  } catch {
    /* handled below */
  }
  if (!result) {
    check(false, `scenario did not report (status=${out.status}) ${(out.stderr ?? '').slice(-300)}`)
  } else {
    check(
      result.repaintedByResize === false,
      `a same-size resize does NOT repaint the session (${result.bytesFromResize} bytes back) — this is why the tab was blank`
    )
    check(
      result.replayHasScreen === true,
      'the retained tail does contain the screen, so replaying it is what fills the new terminal'
    )
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
