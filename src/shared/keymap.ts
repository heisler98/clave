/**
 * The terminal chord table — the single source of truth for how Clave encodes
 * modified keys into terminal input bytes.
 *
 * This lives in `src/shared` rather than next to the hooks because three
 * consumers have to agree byte for byte:
 *   1. `hooks/use-terminal.ts` (local PTY sessions)
 *   2. `hooks/use-remote-terminal.ts` (SSH shell sessions)
 *   3. the iPadOS remote client, which reads the generated
 *      `packages/clave-remote-protocol/keymap.json`
 *
 * Hand-porting the table to Swift is how the two copies drift apart, and this
 * repo already documents that exact failure mode for `.clave` enums in
 * CLAUDE.md. Change the table here and regenerate the JSON in the same commit:
 * `npm run export:keymap`.
 */

/**
 * A single chord: a `KeyboardEvent.key` plus the modifier state it requires.
 *
 * The modifier fields are deliberately tri-state, because the handlers this
 * table replaces were tri-state:
 *   - `true`      — the modifier MUST be held
 *   - `false`     — the modifier MUST NOT be held (an exclusivity guard)
 *   - `undefined` — don't care; the chord matches either way
 *
 * The distinction between `false` and `undefined` is load-bearing. The original
 * handlers tested `e.altKey && !e.metaKey && !e.ctrlKey`, so Option+Cmd+Left
 * fell through to xterm untouched. Collapsing absent modifiers to "don't care"
 * would silently start capturing those combinations.
 */
export interface KeyChord {
  /** Matched against `KeyboardEvent.key` exactly (case-sensitive). */
  key: string
  /** Cmd on macOS. */
  meta?: boolean
  /** Option on macOS. */
  alt?: boolean
  ctrl?: boolean
  shift?: boolean
  /** The exact bytes written to the PTY / SSH shell when the chord matches. */
  bytes: string
  /** Human-readable effect, surfaced in the generated JSON for the Swift side. */
  description: string
}

/** The subset of `KeyboardEvent` the matcher needs. */
export interface KeyChordEvent {
  key: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

/**
 * Order matters: the matcher returns the first entry that matches, exactly as
 * the original chain of `if` statements did. The Option and Cmd variants of
 * Backspace/Delete are mutually exclusive by their guards, so no entry here
 * shadows another — but keep the original order anyway so any future overlap
 * resolves the way it always has.
 */
export const TERMINAL_KEYMAP: readonly KeyChord[] = [
  // Shift+Enter deliberately does not guard the other modifiers: the original
  // handler tested only `e.key === 'Enter' && e.shiftKey`, so Cmd+Shift+Enter
  // has always produced a newline too. Preserved as-is.
  {
    key: 'Enter',
    shift: true,
    bytes: '\n',
    description: 'Shift+Enter → newline'
  },
  {
    key: 'Backspace',
    alt: true,
    meta: false,
    ctrl: false,
    bytes: '\x1b\x7f',
    description: 'Option+Backspace → word delete backward'
  },
  {
    key: 'Delete',
    alt: true,
    meta: false,
    ctrl: false,
    bytes: '\x1bd',
    description: 'Option+Delete → forward word delete'
  },
  {
    key: 'ArrowLeft',
    alt: true,
    meta: false,
    ctrl: false,
    bytes: '\x1bb',
    description: 'Option+Left → word backward'
  },
  {
    key: 'ArrowRight',
    alt: true,
    meta: false,
    ctrl: false,
    bytes: '\x1bf',
    description: 'Option+Right → word forward'
  },
  // macOS Cmd combos are never encoded into terminal input by the OS, so the
  // readline control bytes below are synthesized the way iTerm and Ghostty do.
  {
    key: 'ArrowLeft',
    meta: true,
    alt: false,
    ctrl: false,
    bytes: '\x01',
    description: 'Cmd+Left → start of line (Ctrl-A)'
  },
  {
    key: 'ArrowRight',
    meta: true,
    alt: false,
    ctrl: false,
    bytes: '\x05',
    description: 'Cmd+Right → end of line (Ctrl-E)'
  },
  {
    key: 'Backspace',
    meta: true,
    alt: false,
    ctrl: false,
    bytes: '\x15',
    description: 'Cmd+Backspace → delete to start of line (Ctrl-U)'
  },
  {
    key: 'Delete',
    meta: true,
    alt: false,
    ctrl: false,
    bytes: '\x0b',
    description: 'Cmd+Delete (fn+Delete) → delete to end of line (Ctrl-K)'
  }
]

/** `undefined` on a chord means "don't care", so only defined flags constrain. */
function modifierMatches(required: boolean | undefined, actual: boolean): boolean {
  return required === undefined || required === actual
}

/**
 * Returns the chord this event should be encoded as, or `undefined` when the
 * event is not ours — in which case the caller must fall through to xterm's own
 * handling rather than swallowing the key.
 */
export function matchChord(e: KeyChordEvent): KeyChord | undefined {
  return TERMINAL_KEYMAP.find(
    (chord) =>
      chord.key === e.key &&
      modifierMatches(chord.meta, e.metaKey) &&
      modifierMatches(chord.alt, e.altKey) &&
      modifierMatches(chord.ctrl, e.ctrlKey) &&
      modifierMatches(chord.shift, e.shiftKey)
  )
}

/**
 * Stable identifier for a chord, used as the key clients look chords up by in
 * the generated JSON. Built from the required modifiers only, so it stays
 * stable when a "don't care" modifier is later tightened into a guard.
 */
export function chordId(chord: KeyChord): string {
  const parts: string[] = []
  if (chord.meta === true) parts.push('cmd')
  if (chord.ctrl === true) parts.push('ctrl')
  if (chord.alt === true) parts.push('opt')
  if (chord.shift === true) parts.push('shift')
  parts.push(chord.key)
  return parts.join('+')
}
