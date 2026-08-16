/**
 * A bounded, per-session tail of everything a PTY has printed.
 *
 * Why main has to keep this at all: `ptyManager.spawn()` deliberately defers the
 * real `pty.spawn()` until the renderer has fit its xterm and reported real
 * cols/rows, so the *first* xterm created for a session is the one that receives
 * the child's opening paint. Every terminal created for that session afterwards
 * — React remounting the panel (StrictMode does this to every panel in dev), an
 * error boundary resetting, a tab re-created — starts empty, and nothing in the
 * stack repaints it. The only thing `start()` used to do on that path was resize
 * the pty to the size it already had, and the kernel drops a no-op winsize
 * change without raising SIGWINCH, so tmux and the agent TUIs never redrew. The
 * tab then sat blank behind a blinking cursor until the agent happened to print
 * something of its own — which, for an idle session, could be never.
 *
 * Replaying the tail fixes that for every session type: tmux-backed sessions get
 * their pane back, and a plain shell gets its scrollback back too (a forced
 * SIGWINCH would only ever have helped the full-screen ones).
 *
 * Kept electron-free so `scripts/verify-pty-replay.mjs` can exercise it.
 */

/** Per-session cap on retained output. Sized to hold a full-screen TUI redraw
 *  (a 200×60 truecolor repaint is well under 100 KB) plus some scrollback, so
 *  ~20 adopted sessions cost a few MB of main-process memory. */
export const REPLAY_LIMIT_BYTES = 256 * 1024

export class PtyReplayBuffer {
  /** Retained in whole chunks, never a sliced one: a chunk boundary is where
   *  node-pty already cut the stream, so dropping at one can't strand half an
   *  escape sequence at the head of a replay the way a mid-chunk cut would. */
  private chunks: string[] = []
  private size = 0
  private readonly limit: number

  // Written out rather than as a parameter property so `scripts/verify-pty-replay.mjs`
  // can import this file directly under Node's strip-only TypeScript support.
  constructor(limit: number = REPLAY_LIMIT_BYTES) {
    this.limit = limit
  }

  append(data: string): void {
    if (!data) return
    this.chunks.push(data)
    this.size += data.length
    // Always keep at least one chunk, even if that single chunk is over the
    // limit — a terminal repainted from a too-long tail still beats a blank one.
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length
    }
  }

  /** Everything retained, as one string. Empty when the session has printed
   *  nothing yet, in which case there is nothing to repaint. */
  read(): string {
    if (this.chunks.length === 0) return ''
    if (this.chunks.length > 1) {
      // Collapse so repeated reads (one per remount) don't re-join every time.
      this.chunks = [this.chunks.join('')]
    }
    return this.chunks[0]
  }

  /** Retained byte count. Exposed for the verification script. */
  get byteLength(): number {
    return this.size
  }

  clear(): void {
    this.chunks = []
    this.size = 0
  }
}
