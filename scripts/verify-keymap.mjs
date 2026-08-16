#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain node script, no TS annotations available */
/**
 * Behaviour lock for the terminal chord table.
 *
 * The repo has no test runner (no vitest/jest config, no test files), and the
 * table sits on the hot path for every keystroke the user types — so this is a
 * plain node script instead, wired as `npm run verify:keymap`.
 *
 * It proves three things:
 *   1. Every chord still emits the exact bytes it emitted before extraction.
 *   2. `matchChord` agrees with a verbatim transcription of the pre-refactor
 *      if-chain across the whole modifier space. This is the part that matters:
 *      the old handlers guarded on absent modifiers (`!e.metaKey && !e.ctrlKey`),
 *      and a matcher that quietly dropped those guards would start swallowing
 *      combinations that used to fall through to xterm.
 *   3. The committed keymap.json is in sync with the TypeScript table.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { TERMINAL_KEYMAP, matchChord, chordId } = await import(
  join(repoRoot, 'src', 'shared', 'keymap.ts')
)

let failures = 0
function check(condition, message) {
  if (!condition) {
    failures += 1
    console.error(`FAIL  ${message}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Golden bytes. Transcribed from the handlers as they stood before the
//    extraction (use-terminal.ts:95-152, use-remote-terminal.ts:142-203).
// ---------------------------------------------------------------------------
const GOLDEN = [
  { id: 'shift+Enter', bytes: '\n' },
  { id: 'opt+Backspace', bytes: '\x1b\x7f' },
  { id: 'opt+Delete', bytes: '\x1bd' },
  { id: 'opt+ArrowLeft', bytes: '\x1bb' },
  { id: 'opt+ArrowRight', bytes: '\x1bf' },
  { id: 'cmd+ArrowLeft', bytes: '\x01' },
  { id: 'cmd+ArrowRight', bytes: '\x05' },
  { id: 'cmd+Backspace', bytes: '\x15' },
  { id: 'cmd+Delete', bytes: '\x0b' }
]

check(
  TERMINAL_KEYMAP.length === GOLDEN.length,
  `keymap has ${TERMINAL_KEYMAP.length} chords, expected ${GOLDEN.length}`
)
GOLDEN.forEach((expected, i) => {
  const actual = TERMINAL_KEYMAP[i]
  if (!actual) {
    check(false, `missing chord at index ${i} (${expected.id})`)
    return
  }
  check(chordId(actual) === expected.id, `chord ${i}: id ${chordId(actual)} !== ${expected.id}`)
  check(
    actual.bytes === expected.bytes,
    `chord ${expected.id}: bytes ${JSON.stringify(actual.bytes)} !== ${JSON.stringify(expected.bytes)}`
  )
})

// ---------------------------------------------------------------------------
// 2. Oracle. A verbatim transcription of the original if-chain — do not
//    "simplify" it, its job is to be the old code.
// ---------------------------------------------------------------------------
function originalHandler(e) {
  if (e.key === 'Enter' && e.shiftKey) return '\n'
  if (e.key === 'Backspace' && e.altKey && !e.metaKey && !e.ctrlKey) return '\x1b\x7f'
  if (e.key === 'Delete' && e.altKey && !e.metaKey && !e.ctrlKey) return '\x1bd'
  if (e.key === 'ArrowLeft' && e.altKey && !e.metaKey && !e.ctrlKey) return '\x1bb'
  if (e.key === 'ArrowRight' && e.altKey && !e.metaKey && !e.ctrlKey) return '\x1bf'
  if (e.key === 'ArrowLeft' && e.metaKey && !e.altKey && !e.ctrlKey) return '\x01'
  if (e.key === 'ArrowRight' && e.metaKey && !e.altKey && !e.ctrlKey) return '\x05'
  if (e.key === 'Backspace' && e.metaKey && !e.altKey && !e.ctrlKey) return '\x15'
  if (e.key === 'Delete' && e.metaKey && !e.altKey && !e.ctrlKey) return '\x0b'
  return null
}

// Every key the table touches, plus keys that must never match so the
// fall-through path is covered too.
const KEYS = [
  'Enter',
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Tab',
  'Escape',
  'a',
  'A',
  'k',
  '1',
  ' ',
  'enter',
  'backspace'
]

let cases = 0
for (const key of KEYS) {
  for (let bits = 0; bits < 16; bits += 1) {
    const e = {
      key,
      metaKey: Boolean(bits & 1),
      altKey: Boolean(bits & 2),
      ctrlKey: Boolean(bits & 4),
      shiftKey: Boolean(bits & 8)
    }
    cases += 1
    const expected = originalHandler(e)
    const matched = matchChord(e)
    const actual = matched ? matched.bytes : null
    check(
      actual === expected,
      `${key} meta=${e.metaKey} alt=${e.altKey} ctrl=${e.ctrlKey} shift=${e.shiftKey}: ` +
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Generated artifact is in sync.
// ---------------------------------------------------------------------------
const artifactPath = join(repoRoot, 'packages', 'clave-remote-protocol', 'keymap.json')
let artifact
try {
  artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
} catch (err) {
  check(false, `cannot read ${artifactPath}: ${err.message}`)
}

if (artifact) {
  check(
    artifact.chords.length === TERMINAL_KEYMAP.length,
    `keymap.json has ${artifact.chords.length} chords, table has ${TERMINAL_KEYMAP.length} — run npm run export:keymap`
  )
  TERMINAL_KEYMAP.forEach((chord, i) => {
    const exported = artifact.chords[i]
    if (!exported) {
      check(false, `keymap.json missing chord ${chordId(chord)} — run npm run export:keymap`)
      return
    }
    check(exported.id === chordId(chord), `keymap.json chord ${i}: id drift (${exported.id})`)
    check(exported.key === chord.key, `keymap.json chord ${exported.id}: key drift`)
    const expectedBytes = Array.from(new TextEncoder().encode(chord.bytes))
    check(
      JSON.stringify(exported.bytes) === JSON.stringify(expectedBytes),
      `keymap.json chord ${exported.id}: bytes drift — run npm run export:keymap`
    )
    for (const name of ['meta', 'alt', 'ctrl', 'shift']) {
      const expectedModifier = chord[name] === undefined ? null : chord[name]
      check(
        exported.modifiers[name] === expectedModifier,
        `keymap.json chord ${exported.id}: ${name} drift — run npm run export:keymap`
      )
    }
  })
}

if (failures > 0) {
  console.error(`\n${failures} keymap check(s) failed.`)
  process.exit(1)
}
console.log(
  `keymap OK — ${TERMINAL_KEYMAP.length} chords, ${cases} event permutations, artifact in sync.`
)
