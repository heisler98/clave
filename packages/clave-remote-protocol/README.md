# clave-remote-protocol

Cross-language artifacts shared between Clave desktop and the iPadOS remote client.

## `keymap.json`

The terminal chord table: how a modified key press becomes terminal input bytes. Both desktop
terminal handlers (`src/renderer/src/hooks/use-terminal.ts` for local PTY sessions,
`use-remote-terminal.ts` for SSH sessions) and the iPad client's key encoder read the same table,
so a chord types the same thing on every surface.

### Shape

Each entry carries the `KeyboardEvent.key` name, the modifier constraints, the bytes as an array of
integers (`bytes`, ASCII, ready for `[UInt8]`), a readable `bytesHex` for eyeballing, and a
description.

Modifiers are tri-state, and the distinction matters:

| Value   | Meaning                       |
| ------- | ----------------------------- |
| `true`  | modifier must be held         |
| `false` | modifier must **not** be held |
| `null`  | modifier is unconstrained     |

`false` is a real guard, not a default. Cmd+Left declares `alt: false`, so Cmd+Option+Left falls
through to the terminal's own handling instead of being captured. A client that treats `false` and
`null` as the same thing will start swallowing chords the desktop passes through.

Matching is first-match-wins in array order, so preserve the order when you load it.

### Regenerating

`keymap.json` is generated. The source of truth is `src/shared/keymap.ts`.

```
npm run export:keymap    # regenerate keymap.json from the TS table
npm run verify:keymap    # assert the table and the artifact still agree
```

Never edit `keymap.json` by hand: the next export silently overwrites it.

## Mirror rule

This extends the `.clave` enum sync rule in `CLAUDE.md` to a third artifact. When you change the
chord table, all of the following move in the same commit:

1. `src/shared/keymap.ts` — the source of truth, and the only file you edit.
2. `packages/clave-remote-protocol/keymap.json` — regenerated, never hand-edited.
3. `scripts/verify-keymap.mjs` — its golden byte table, so the check keeps proving something.
4. The iPad client's table-driven keymap test, which loads this JSON.

The failure mode is quiet, which is why the rule exists: a drifted chord does not crash, it just
types the wrong bytes into someone's agent session.
