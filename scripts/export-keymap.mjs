#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain node script, no TS annotations available */
/**
 * Generates packages/clave-remote-protocol/keymap.json from the TypeScript
 * source of truth in src/shared/keymap.ts.
 *
 * The iPad client cannot import a .ts file, and hand-porting the table to Swift
 * is exactly the drift this whole exercise exists to prevent — so the artifact
 * is generated and committed, never edited. Run `npm run export:keymap` after
 * any change to the table.
 *
 * Node strips the TypeScript types natively (v22.18+), so keymap.ts must stay
 * erasable-syntax-only: no enums, no namespaces, no parameter properties.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = join(repoRoot, 'packages', 'clave-remote-protocol', 'keymap.json')

const { TERMINAL_KEYMAP, chordId } = await import(join(repoRoot, 'src', 'shared', 'keymap.ts'))

/**
 * Swift decodes `[UInt8]` far more comfortably than it re-parses `\x1b` escape
 * strings, so integers are the primary encoding. `bytesHex` rides along purely
 * so a human reading the JSON can tell what a chord does at a glance.
 */
function encodeBytes(bytes) {
  const encoded = Array.from(new TextEncoder().encode(bytes))
  for (const byte of encoded) {
    if (byte > 0x7f) {
      throw new Error(
        `Chord bytes must be ASCII, got 0x${byte.toString(16)} in ${JSON.stringify(bytes)}`
      )
    }
  }
  return encoded
}

function toHex(byteValues) {
  return byteValues.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

/**
 * `null` means "this modifier is unconstrained" — the tri-state from keymap.ts
 * carried across the language boundary. A Swift client must treat null as
 * "match either way" and false as "must not be held", or it will start
 * capturing combinations the desktop lets fall through.
 */
function modifier(value) {
  return value === undefined ? null : value
}

const chords = TERMINAL_KEYMAP.map((chord) => {
  const byteValues = encodeBytes(chord.bytes)
  return {
    id: chordId(chord),
    key: chord.key,
    modifiers: {
      meta: modifier(chord.meta),
      alt: modifier(chord.alt),
      ctrl: modifier(chord.ctrl),
      shift: modifier(chord.shift)
    },
    bytes: byteValues,
    bytesHex: toHex(byteValues),
    description: chord.description
  }
})

const artifact = {
  $comment:
    'Generated from src/shared/keymap.ts by scripts/export-keymap.mjs. Do not edit by hand — run `npm run export:keymap`.',
  version: 1,
  source: 'src/shared/keymap.ts',
  modifierSemantics: {
    true: 'modifier must be held',
    false: 'modifier must not be held',
    null: 'modifier is unconstrained'
  },
  matching: 'First chord whose key and modifier constraints all match wins; order is significant.',
  chords
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)
console.log(`Wrote ${chords.length} chords to ${outputPath}`)
