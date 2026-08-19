# Clave for iPadOS — remote client plan

A native iPadOS app that attaches to Clave instances running on your Macs over SSH, with
first-class pointer, keyboard, and multi-host support.

Every claim about the current codebase below has a `file:line` anchor. Verified against Clave on
branch `feat/fork-proposals`, tmux `3.7b`.

**Decisions taken up front** (they shape everything else):

| Decision | Choice |
|---|---|
| Host side | Build a real remote-access service in Clave desktop now |
| Terminal engine | SwiftTerm, native |
| v1 scope | Multiple hosts, session switcher, attachable terminals, pointer + keyboard |

---

## 1. What already exists, and why it is most of the work

The thing that makes this project small is that **Clave already runs every session inside a
detached tmux server**, on a private socket, with a config Clave controls.

| Piece | Location | What it gives the iPad |
|---|---|---|
| tmux socket `clave` | `pty-manager.ts:176-178` | A server that outlives the app and accepts more clients |
| `destroy-unattached off` | `pty-manager.ts:224` | Detaching the iPad never kills an agent |
| `set -g mouse on` + wheel bindings | `pty-manager.ts:237-241` | Mouse reporting and scrollback already wired |
| `allow-passthrough on`, `extended-keys on` | `pty-manager.ts:247-251` | OSC passthrough and modified-key encoding |
| `window-size latest` | `pty-manager.ts:244` | Multi-client sizing policy (and the one real conflict, see §4) |
| Deterministic session names | `pty-manager.ts:283-290`, validated at `:349-351` | Stable attach targets across restarts |
| Sidecar metadata | `pty-manager.ts:307-345`, `~/Library/Application Support/clave/clave-tmux-sessions/*.json` | Session id, cwd, mode, display name, profile |
| tmux mode default on | `session-store.ts:314` | Most existing sessions are already attachable |
| Loopback MCP server + token | `mcp-server.ts:460`, `mcp-runtime.ts:41-62` | The exact security pattern to copy |
| Command layer | `mcp-dispatcher.ts:440-478` | Open, close, rename, focus, move, launch group, notify, already written and shipping |
| Host-key TOFU pinning | `ssh-manager.ts:74-95` | The trust model to mirror on iOS |

The existing desktop-to-desktop remote path is **not** the model to copy. `Sidebar.tsx:148-194`
opens a raw SSH shell and types `claude\r` into it after a 500ms sleep. That starts a *new* agent
on the remote box; it does not connect you to the Clave running there. The iPad client is a
different and better thing: a second head on an existing Clave.

---

## 2. Architecture

Two planes over one SSH connection per host.

```
iPad                                   Mac (Clave running)
┌──────────────────────────┐           ┌─────────────────────────────────┐
│ ClaveKit                 │           │                                 │
│  ├ SSHConnection ────────┼─ SSH ─────┤ sshd                            │
│  │   ├ direct-tcpip ─────┼───────────┼→ 127.0.0.1:<port>               │
│  │   │   (control plane) │           │   remote-server.ts (WS + token) │
│  │   │                   │           │        ↕ command bridge          │
│  │   │                   │           │   Electron main ↔ renderer      │
│  │   └ session channels ─┼───────────┼→ tmux -L clave attach -t <name> │
│  │       (data plane)    │           │        ↕                         │
│  │                       │           │   tmux server (daemon)          │
│  └ TerminalSurface       │           │        ↕                         │
│    (SwiftTerm)           │           │   claude / codex / shell        │
└──────────────────────────┘           └─────────────────────────────────┘
```

**Control plane** — a WebSocket to a new loopback service inside Clave's main process, reached
through an SSH `direct-tcpip` forward. Carries the session model, live activity, notifications,
and every command Clave can already perform.

**Data plane** — one SSH session channel per attached terminal, with a `pty-req`, running
`tmux attach-session`. Terminal bytes never touch the control plane. This matters: tmux does the
redraw and replay on attach, back-pressure is per-channel, and a wedged control socket cannot
freeze your typing.

**Why not stream PTY bytes through the service?** Because then Clave has to reimplement what tmux
already does correctly (scrollback, instant repaint on attach, per-client sizing). The one thing
that path would buy is attaching to sessions started with tmux mode off; §9 covers that as a later
phase.

---

## 3. Host service (this repo)

New files:

```
src/main/remote/remote-server.ts       WebSocket server, auth, protocol
src/main/remote/remote-state.ts        Port + token persistence, paired devices
src/main/remote/remote-attach.ts       Validated tmux attach descriptors
src/main/ipc-handlers/remote-handlers.ts
src/renderer/src/lib/remote-bridge.ts  Zustand → main state pushes
src/renderer/src/components/settings/RemoteAccessTab.tsx
packages/clave-remote-protocol/        Shared wire types + keymap table
```

### 3.1 Security posture

Copy `ClaveChannelServer` (`packages/clave-channel/src/server.ts:40-56`) and `mcp-server.ts:25-31`
line for line where they already got this right:

- **Bind `127.0.0.1` only.** The single way in is an SSH forward, so reaching the port already
  requires authenticating as that user. Nothing is exposed to the LAN.
- **Fail closed without a token.** Refuse to start rather than start unauthenticated.
- **Constant-time bearer comparison** over sha256 digests, so unequal lengths are safe.
- **Bounded frames** (`MAX_PAYLOAD_BYTES`, 1 MB).
- **Token in a `0600` file**, never on a command line: `remote-server.json` alongside
  `mcp-server.json`, written with the same tmp-then-rename dance as `mcp-runtime.ts:58-62`.
- **Default off.** One toggle in Settings. This grants full control of every agent session, and
  "anyone who can SSH in could run code anyway" is true but is not a reason to make it implicit.
- **Per-device pairing.** First connection from an unknown client id raises a desktop dialog
  naming the device. Approved devices are listed in Settings with last-seen and a revoke button.
  SSH already proves identity; pairing gives you a visible inventory and a kill switch.

### 3.2 Protocol

JSON over WebSocket. Versioned with a `protocol` integer; the client refuses a host it cannot
speak to and says which side needs updating.

```
→ hello    { clientId, deviceName, appVersion, protocol }
← welcome  { hostName, claveVersion, protocol, capabilities[], pairing: "approved"|"pending" }
→ subscribe
← state    { sessions[], groups[], pinnedGroups[], displayOrder[] }   full snapshot
← patch    { sessions?: {...}, groups?: {...} }            deltas thereafter
← event    { kind: "activity"|"prompt-waiting"|"exit"|"notification", sessionId, ... }
→ command  { id, command: "openSession"|"closeSession"|"rename"|..., payload }
← result   { id, ok, result|error }
→ attach   { sessionId }
← attachInfo { tmuxName, socket, tmuxPath, configPath, cols, rows, remotable, reason? }
```

`command` maps straight onto `execute()` in `mcp-dispatcher.ts`. Every verb the MCP tools
expose is already implemented, tested, and shipping; the remote service reuses the dispatcher
rather than growing a parallel one. That is the single biggest reason the host-service route is
cheap: **the control surface is already written.**

Organizing the sidebar from a remote client is the same trick a second time. `moveItems`,
`ungroupSessions`, `deleteGroup`, `setGroupColor` and `undoSidebar` are the store actions the
sidebar's own drag and drop and context menus call, exposed through the dispatcher rather than
reimplemented, and `createGroup` grew the `sessionIds` its Cmd+G already passes. The host
advertises the lot as the `organize` capability, so a client older or newer than its Mac hides the
feature rather than failing on it. The one new piece of state is `displayOrder`: the sidebar's
top-level order, which a client has to hold to render the order it is reordering, and which no
other field implies (dragging a top-level tab past another changes nothing else in the model, so a
reorder is broadcast as a whole `state`).

Session objects carry what the sidebar shows plus what the iPad needs:

```ts
{ id, name, folderName, cwd, mode, groupId, color,
  alive, activityStatus, promptWaiting, agentState, unseenActivity,
  detectedUrl, serverStatus,
  tmuxName: string | null,        // main-side fact, absent from handleList today
  remotable: boolean, reason?: string }
```

`tmuxName` lives in the pty manager, not the renderer (`handleList` at `mcp-dispatcher.ts:51-96`
does not expose it). So the service composes both sides: main contributes tmux facts, the renderer
contributes the UI model over the existing command bridge (`mcp-bridge.ts`, `initMcpDispatcher` at
`mcp-dispatcher.ts:481-496`). Extend that bridge, do not invent a second one.

### 3.3 Attach descriptors

The client never composes a shell command. It asks for a session id and gets back a validated
descriptor. `isValidTmuxName` (`pty-manager.ts:349-351`) already exists and must gate this, because
the socket is user-attachable and a name prefix is not proof of ownership (the code says so at
`pty-manager.ts:913`).

The client then opens a channel running exactly:

```
<tmuxPath> -u -L clave -f <configPath> attach-session -t <tmuxName> -f ignore-size
```

### 3.4 Settings UI

A Remote Access section in `SettingsPanel.tsx`, next to the tmux toggle:

- Enable remote access (off by default)
- Paired devices, with last seen and Revoke
- Require approval for new devices
- A short line explaining that access requires an SSH login to this Mac

Copy rules apply: no em-dashes, and describe what a setting does rather than what it avoids.

---

## 4. The sizing problem, and the fix

This is the one genuinely hard interaction, so it gets its own section.

tmux windows have a single size shared by every client viewing them. Clave sets
`window-size latest` (`pty-manager.ts:242-244`) deliberately, so an external `tmux attach` wins the
size. If the iPad attaches naively at 96x30 while the Mac's pane is 180x50, **the Mac's Clave
window reflows to 96x30** and the user watching the desktop sees their layout collapse.

**Fix: attach with `-f ignore-size`, AND size the iPad's pty to the host's grid.** Both halves are
required. P0-A measured this directly (`docs/p0-findings.md`), and the naive version of this
section was wrong.

`ignore-size` does exactly what the manual says: the client is excluded from window-size
calculation, so the desktop's 180x50 survives an iPad attaching at 96x30. But **a client narrower
than the window is clipped, not scaled**: at 96 columns it receives only columns 1-96 and never
learns the rest exists. Clipping is a function of the client's own width and is entirely
independent of the flag. So "attach small and render the big grid" is not a thing tmux will do.

The working combination, measured:

| Client size | Flag | Window ends up | Client receives |
|---|---|---|---|
| 96x30 | none | **96x30** (desktop destroyed) | everything, reflowed to 96 |
| 96x30 | `ignore-size` | 180x50 (desktop safe) | **clipped to 96 columns** |
| 180x50 | `ignore-size` | 180x50 (desktop safe) | **the full grid** |

So Mirror mode is: **request a pty sized to the host's current window, pass `-f ignore-size`, and
scale the font down to fit the physical screen.** The flag is then a guard rather than the
mechanism: it makes it impossible for the iPad to reflow the Mac during the window between a host
resize and the iPad's resync.

Three per-session modes, remembered per session and settable as a global default:

| Mode | Client pty | Attach | Effect |
|---|---|---|---|
| **Mirror** (default) | host's cols x rows | `-f ignore-size` | Full fidelity, desktop geometry untouched. Font scales to fit; pan when the scale gets too small. |
| **Takeover** | iPad's natural grid | plain attach | tmux reflows the window to the iPad. Right when the Mac is asleep or unattended. Implemented client-side as `.fitPane` sizing: the surface derives cols x rows from the visible pane at a readable font (`ClaveTerminalView.applyFitToPane`), reports grid changes to `HostRuntime.takeoverGridChanged`, and the driver re-sizes its SSH pty (`window-change`) so tmux follows. Host `geometry` events are ignored for attachments without `ignore-size` (`LiveHostDriver.applyGeometry`), because in takeover the iPad, not the Mac, owns the size. |
| **Watch** | host's cols x rows | `-f read-only,ignore-size` | Read-only monitoring, verified to block input. Genuinely useful on a tablet. |

Mirror mode is more viable than it sounds. An 11-inch iPad in landscape is about 1180pt wide; at
9pt SF Mono (~5.4pt advance) that is roughly 215 columns, comfortably above the 120-180 a Clave
pane typically runs. Portrait is where scaling earns its keep.

A fourth per-session view, **Chat**, sits beside these three for Claude Code sessions. It is not a
tmux attach mode at all — it opens no terminal channel and rides the control plane both ways — so
it lives outside this table; see §8f.

**Resync is mandatory, not an optimisation.** When the desktop resizes, a Mirror client at the old
size is silently clipped until it follows (measured: B-run truncated from 100 to 82 chars). The
host service must push geometry changes over the control plane and the client must re-issue
`window-change`; a resync restores full fidelity immediately. tmux control mode (`-CC`) reports the
same thing unprompted as `%layout-change @0 bfbd,150x45,0,0,0`, which is a viable alternative data
plane and a good fallback if we ever want multi-pane rendering, but our own control plane already
knows the geometry, so it should just send it.

Two follow-ons:

- The tmux config is read only when the server **first starts** (`pty-manager.ts:665-669` and the
  comment at `:407`). Any config change this project needs must also go into
  `reconcileTmuxBindings` (`pty-manager.ts:413-425`) so live servers pick it up without a restart.
  That precedent already exists; follow it. This is not theoretical: the P0 harness accidentally
  started a server without `-f`, and every mouse assertion silently passed for the wrong reason
  (with `mouse off`, tmux forwards mouse bytes uninterpreted rather than acting on them). Any test
  in this area must assert `show-options -gv mouse` is `on` before trusting a result.
- Takeover mode should push a `notification` event back to the desktop so a user at the Mac sees
  why their pane just changed shape.

---

## 5. Keyboard

The stated requirement is first-class keybindings, which on iPadOS means three separate systems.

### 5.1 Parity is a shared table, not a reimplementation

Clave desktop encodes modified keys in two places today, `use-terminal.ts:95-152` and
`use-remote-terminal.ts:142-203`, with an identical table:

| Key | Bytes | Effect |
|---|---|---|
| Shift+Enter | `\n` | newline in the agent prompt |
| Option+Backspace | `\x1b\x7f` | delete word backward |
| Option+Delete | `\x1bd` | delete word forward |
| Option+Left / Right | `\x1bb` / `\x1bf` | word motion |
| Cmd+Left / Right | `\x01` / `\x05` | line start / end |
| Cmd+Backspace | `\x15` | delete to line start |
| Cmd+Delete | `\x0b` | delete to line end |

Hand-porting this to Swift guarantees drift. Instead, **extract it to
`packages/clave-remote-protocol/keymap.json`**, have both TS handlers and the Swift encoder read
it, and add a table-driven test on each side. Then add it to the mirror rule already documented in
`CLAUDE.md` (the `.clave` enum sync rule), because this repo has exactly this failure mode
documented already and it bit before.

### 5.2 Hardware keyboard

The terminal view owns `pressesBegan/Changed/Ended/Cancelled` rather than registering
`UIKeyCommand`s for terminal keys, because UIKeyCommand cannot express the full Ctrl and Meta
space and eats keys the terminal needs.

- **Ctrl chords** from `UIKey.charactersIgnoringModifiers` plus `modifierFlags`: `0x01`-`0x1a`,
  plus Ctrl+`[ \ ] ^ _` and Ctrl+Space to NUL.
- **Option as Meta**, ESC-prefixed, default on, with a setting for users who type accented
  characters.
- **Cmd** from the shared keymap. Only the table's keys are consumed; every other Cmd chord falls
  through to the app.
- **Keys with no character** (arrows, F-keys, Home/End/PgUp/PgDn) from
  `UIKeyboardHIDUsage`, encoded per the current DECCKM mode SwiftTerm tracks.
- **App shortcuts** registered as `UIKeyCommand` on a *parent* responder so the terminal wins the
  overlap: Cmd+T new session, Cmd+1..9 select, Cmd+K host and session switcher, Cmd+F transcript
  search, Cmd+Shift+[ / ] cycle, Cmd+Shift+W detach. Mirroring the desktop's move of session close
  off Cmd+Backspace onto Cmd+Shift+W (`docs/fork-proposals.md:477-480`) keeps muscle memory intact.
  Use `wantsPriorityOverSystemBehavior` where iPadOS would otherwise claim the chord.

**Key repeat is already solved upstream** (P0-C). SwiftTerm implements its own repeat engine, a
`Timer` at 0.4s initial delay and 0.1s interval, armed in `pressesBegan` across all four encoder
paths. We do not need to build one.

What still needs checking: the observed cancel path is `pressesEnded` only. If `pressesCancelled`
does not also invalidate the timer, backgrounding the app mid-hold leaves a key repeating, which is
precisely the failure that sends a held `y` into a permission prompt. Verify, and fix in the
subclass if needed.

**Two encoder paths, not one.** SwiftTerm ships a full Kitty keyboard protocol implementation
alongside the legacy encoder, and `pressesBegan` branches between them. Any interception must
handle both. This also raises a design question worth settling early: Kitty's unambiguous
modifier reporting is a better foundation than a hardcoded byte table, and if the desktop adopted
it too, parity would come from the protocol rather than from a mirrored JSON file.

**IME and dead keys** route through `UITextInput` marked text; only committed text is encoded.

### 5.3 Software keyboard and the accessory bar

Without this the app is unusable on a bare iPad, since a raw PTY needs Esc, Tab, and Ctrl and the
software keyboard has none.

A persistent row above the keyboard:

- Row 1: Esc, Tab, Ctrl, Opt, arrows, `/`, `|`, `~`, `-`
- Row 2 (agent context): Esc to interrupt, Shift+Tab, `@`, `#`, `!`, Ctrl+C, Ctrl+R

Sticky modifiers: tap to arm for one key, double tap to lock. Long-press for a repeat.

**Compose sheet.** A real multi-line text view for writing a prompt, sent as one bracketed paste
(`\x1b[200~ ... \x1b[201~` when DECSET 2004 is active). Typing a paragraph of instructions into a
raw PTY on a tablet is miserable, and this single feature is likely to be the most-used thing in
the app. It also gives you dictation, autocorrect off, and a send button for free.

---

## 6. Pointer and touch

### 6.1 Pointer

P0-C measured exactly how much of this SwiftTerm gives us and what has to be built. The encoding
layer is done; the *input* layer is where the work is.

- **`UIPointerInteraction`** on the grid: I-beam over text, arrow over chrome, hover effects on
  the session list. SwiftTerm installs a pointer interaction but only implements `regionFor`, so
  there is no pointer shape over the grid today. Implement `styleFor` in the subclass (~1h,
  verified reachable).
- **Mouse reporting** via SGR 1006 when the pane's program requests tracking. Verified working end
  to end in both halves: SwiftTerm emits correct SGR (P0-C), and tmux's `#{mouse_any_flag}`
  bindings at `pty-manager.ts:238-239` route it to the app when wanted and to scrollback when not
  (P0-A3, 7/7). The desktop's behavior carries over unchanged.
- **Hover motion** is never forwarded upstream, which breaks mode 1003. Add a
  `UIHoverGestureRecognizer` calling `terminal.sendMotion(...)` (~2h).
- **Wheel is the biggest gap.** `TerminalView` is a `UIScrollView` and swallows trackpad scroll
  into its own scrollback; it never becomes a button 4/5 report. Add a `UIPanGestureRecognizer`
  with `allowedScrollTypesMask = .all` and `allowedTouchTypes = [.indirectPointer]`, and drive
  `isScrollEnabled` off `mouseMode` (~3h). Then coalesce: accumulate deltas, emit one wheel event
  per line-height of travel, rate-limit to ~60/s, honor momentum phase, cancel on a new gesture.
- **Secondary button** is not reported at all (no `buttonMask` use in the iOS view). Needs an
  `.indirectPointer` gesture (~2h) for the "forward right-click to the app" setting; the default
  native context menu does not depend on it.

Two upstream traps found while building this in P3, both worth knowing before touching the file:

- **Do not use `Terminal.encodeButton` for wheel reports.** It maps buttons 6 and 7 to `0`, so a
  horizontal trackpad scroll would reach the application as a **left click**. P3 ships its own
  `MouseReport` encoder, with a test pinning agreement with upstream for every button upstream does
  handle, so the two cannot drift.
- **SwiftTerm synthesises arrow keys from a finger drag.** `panSelectionHandler` calls
  `sendKey(deltaCol:deltaRow:)` when no selection is active, which is exactly the "tap does not
  move the cursor" rule in §6.2 being violated by the library. P3 intercepts the gesture and
  refuses it unless a selection exists.
- **Secondary click** opens a native context menu by default: Copy, Paste, Paste as prompt,
  Select All, Transcript, Interrupt, Detach. A setting forwards it as button 2 instead. Paste
  behind a right-click is worth more on iPad than mouse-button fidelity.
- **Selection.** Local selection over the rendered grid when mouse reporting is off. When the app
  has grabbed the mouse, holding Option forces local selection, matching iTerm and Ghostty.

### 6.2 Touch

- Two-finger pan scrolls scrollback, pinch changes font size, long-press selects with the system
  magnifier, three-finger tap opens the context menu.
- Tap focuses. Tap does **not** synthesize arrow keys to move the cursor; that guess is wrong often
  enough to be dangerous next to an agent prompt.
- A live/scrolled indicator with a scroll-to-bottom button.

### 6.3 Copy, search, and scrollback: the transcript view

Scrollback lives in the tmux server, not in the client's buffer, since attach only paints the
visible pane. Rather than driving tmux copy-mode from a tablet, pull it:

```
tmux -L clave capture-pane -p -e -S -50000 -t <name>
```

over a short-lived exec channel, into a native transcript sheet with system text selection,
search, and share. That is a better tablet experience than copy-mode, needs no config change, and
solves copy, search, and export in one screen. Wheel scrolling still enters copy-mode for a quick
glance back.

---

## 7. iPad app

Separate repo, `codika-io/clave-ios`. Different toolchain, different release cadence, App Store
review. The wire protocol and keymap stay in this repo under
`packages/clave-remote-protocol/` and are mirrored into Swift with a checked-in generator plus a
test, under the same sync discipline as the `.clave` enums.

### 7.1 Modules

| Module | Contents |
|---|---|
| `ClaveKit` | SSH transport, tunnel manager, control-plane client, models, keychain, host-key store |
| `ClaveTerminal` | SwiftTerm host view, input encoder, pointer handling, accessory bar, transcript |
| App | SwiftUI `NavigationSplitView`: hosts, sessions, terminal. Multiple scenes for Stage Manager. External display support. |

P0-C validated SwiftTerm on an iPad simulator and found no reason to fork: the mouse encoder,
selection, bracketed paste, OSC 52, explicit `cols x rows` sizing, and a key-repeat engine are all
already there, and `pressesBegan` / `send(_:)` are `open`/`public`, so our chord table can run
ahead of SwiftTerm's own encoder. Budget ~2-3 days to close the input gaps listed in §6.

Two things to get right in the subclass:

- **Never call `TerminalView.resize()` on the mirror resync path.** It calls
  `terminal.softReset()`, which clears terminal state every time the host resizes. Call
  `terminal.resize(cols:rows:)` and then `sizeChanged(source:)` instead. Measured at
  `Terminal.swift:4571-4592`, the modes actually lost are **DECCKM** (`applicationCursor`),
  `applicationKeypad`, the scroll region, origin/insert/wraparound, and charset. Losing DECCKM
  breaks every arrow key in vim, less, and tmux copy-mode, so this remains the most likely bug in
  the whole client.
- **`TerminalView` is a `UIScrollView`**, which fights both mirror sizing and wheel reporting.
  Expect `isScrollEnabled` to be driven by the current mouse mode.

`iOSAccessoryView.swift` already ships a Ctrl/Esc/arrows accessory bar, so §5.3 extends something
rather than starting from zero.

### 7.2 SSH library

Settled by P0-B against a real sshd. Every requirement works: pty-req, `window-change` on a live
channel, `direct-tcpip`, ed25519 auth, and a host-key callback whose fingerprint matched
`ssh-keygen -lf` exactly. Three pty channels plus a port forward multiplexed over one connection,
each resized independently, which is the whole two-plane design proven end to end.

**Build on `apple/swift-nio-ssh` directly rather than on Citadel.** Citadel was the original bet
and it works, but it does not depend on Apple's package: `Package.swift:20` pins
`github.com/Wellz26/swift-nio-ssh` at a floating `"0.3.4" ..< "0.4.0"`, a community fork maintained
by an individual. That package is the layer holding the user's SSH keys to their own machines.

Every primitive the spike exercised is present in Apple's upstream (HEAD `3ec2814`, actively
maintained): `PseudoTerminalRequest`, `WindowChangeRequest`, `SSHChannelType.DirectTCPIP`,
`NIOSSHClientServerAuthenticationDelegate`, ed25519 auth. Citadel is an ergonomic wrapper over
things we already have first-party.

**Built and verified in P2.** No shim was needed for the host-key fingerprint:
`String.init(openSSHPublicKey:)` is public (`NIOSSHPublicKey.swift:461`) and the resulting
`SHA256:` fingerprint matches `ssh-keygen -lf` byte for byte on a live handshake. The gap that did
exist was the opposite one: NIOSSH ships no OpenSSH **private**-key parser, so P2 added ~230 lines
of bounds-checked `openssh-key-v1` read/write for ed25519, round-tripped against `ssh-keygen -y`.

If schedule pressure wins, Citadel is acceptable **only** with both repositories vendored at pinned
SHAs rather than a version range, plus a diff audit against upstream.

`keyboard-interactive` is unavailable on either path: NIOSSH's auth state machine is `internal` and
its offer enum has no case for it, so it is unreachable without a ~300 LOC fork made awkward by SSH
message id 60 being context-dependent. Do not build it. Public-key auth is the normal path for
one's own Mac.

Two traps to design around from day one:

- **Concurrency.** Nothing in Citadel's surface is `Sendable`, and a hand-rolled layer faces the
  same question. Put an `SSHSession` actor around each channel that vends a Sendable façade, and
  never let a raw writer leak into SwiftUI code. The channel read loop has to stay inline.
- **Clean exits look like crashes.** `withPTY`-style helpers close the channel on success *and*
  error, so a normally-exiting remote shell surfaces `ChannelError.alreadyClosed`. Unhandled, every
  clean session exit reads as a spurious disconnect.

SFTP is **not** a v1 dependency, because the host service supplies the session model, which removes
the reason the desktop client needed SFTP in the first place.

### 7.3 Credentials and trust

- Generate an Ed25519 key on device. Store in Keychain, `...WhenUnlockedThisDeviceOnly`, guarded
  by a `SecAccessControl` biometry policy. Show the public key with a copy button and a one-line
  `authorized_keys` instruction.
- Import existing keys from Files or paste, with a passphrase prompt for encrypted keys.
- **Host-key TOFU pinning**, mirroring `ssh-manager.ts:74-95`: pin on first connect, show the
  fingerprint, hard-fail on mismatch with a screen that explains what a mismatch means and how to
  clear it deliberately.
- Password auth available but not the default path.

### 7.4 Network reality

- **On background**: `beginBackgroundTask` for the grace window, then tear down cleanly. tmux keeps
  every agent running, which is the whole reason this design works on a mobile OS.
- **On foreground**: reconnect all hosts in parallel and reattach every open session. tmux repaints
  the pane immediately, so the user lands on current state rather than a stale buffer.
- **Path changes**: `NWPathMonitor` triggers a proactive reconnect on Wi-Fi to cellular.
- **Keystrokes typed while disconnected are discarded, visibly.** Buffering and replaying them into
  an agent is how a stray `y` answers a permission prompt you never read. Show what was dropped and
  let the user retype.
- **Latency is the honest limit.** SSH round trip on cellular is 60-150ms and there is no local
  echo possible through a full-screen TUI. Mosh-style predictive echo is out of scope. Say so in
  the README rather than let users discover it.
- **Recommended topology: Tailscale or WireGuard.** The existing `openclawTransport: 'trusted'`
  field (`remote-types.ts:20-30`) already encodes this idea. Reaching your Mac over a tailnet beats
  forwarding SSH to the internet, and the app should say so during host setup.

### 7.5 Multi-host

- Independent SSH connections per host, each with its own control channel and up to ~8 attached
  terminals (each attach is a tmux client process).
- Per-host state machine surfaced as a pill: disconnected, connecting, authenticating, verifying
  host key, connected, degraded.
- **A unified activity view across all hosts**, sorted by who is waiting on you. This is the actual
  payoff of multi-client: one screen showing every agent on every machine that needs an answer.
- **Per-host accent color**, reusing Clave's group palette, shown on the terminal border and in
  split view. When two panes from two machines sit side by side, the cost of typing into the wrong
  one is unbounded, and color is the cheapest guard against it.
- Sessions from different hosts can share a split view.

---

## 8. Phasing

| Phase | Work | Where | Estimate |
|---|---|---|---|
| ~~**P0**~~ | ~~Spikes~~ **Done.** Results in `docs/p0-findings.md`; four plan changes folded in | both | took ~1 day |
| ~~**P1**~~ | ~~Host service~~ **Done.** See "P1 as built" below. Verified end to end: 27/27 protocol checks against the running app | this repo | took ~1 day |
| ~~**P2**~~ | ~~iPad shell~~ **Done.** See "P2 as built" below. Full chain demonstrated live: iPad app to SSH to Clave to a tmux session rendering, including geometry resync | clave-ios | took ~1 day |
| ~~**P3**~~ | ~~Input excellence~~ **Done.** See "P3 as built" below. 148 tests, 0 failures; simulator and device builds both green | clave-ios | took ~1 day |
| **P4** | Multi-session and multi-host: split view, unified activity, local notifications, reconnect behavior | clave-ios | ~1.5 weeks |
| **P5** | Polish and ship: three themes matching the desktop, settings, VoiceOver pass, TestFlight, App Store | clave-ios | ~1.5 weeks |

Roughly 9-10 weeks of focused work for v1, with P1 shippable to the desktop independently and worth
having on its own. P2 grew by a week for the first-party SSH layer; P3 shrank slightly because
SwiftTerm already supplies the key-repeat engine and an accessory bar.

**P0 is closed.** It existed because three assumptions carried the design. All three held: the
two-plane architecture multiplexes correctly over one SSH connection, mouse reporting survives
Clave's tmux config intact, and reattach is cheap. The corrections it produced are in §4, §5.2,
§6, and §7.2. The one thing it did not answer, iOS backgrounding and control-channel resume, moves
to the front of P2.

---

## 8b. P1 as built

Shipped files:

```
src/shared/remote-protocol.ts                       wire contract, IPC channel names, preload surface
src/shared/keymap.ts                                the chord table, single source of truth
src/main/remote/remote-state.ts                     token, prefs, device roster (0600, tmp-then-rename)
src/main/remote/remote-attach.ts                    validated tmux attach descriptors
src/main/remote/remote-server.ts                    WebSocket server, auth, protocol, snapshot diffing
src/main/ipc-handlers/remote-handlers.ts            IPC surface
src/renderer/src/lib/remote-bridge.ts               Zustand to main snapshot push
src/renderer/src/components/settings/RemoteAccessSection.tsx
scripts/export-keymap.mjs, scripts/verify-keymap.mjs
packages/clave-remote-protocol/keymap.json          the artifact the Swift client consumes
```

Deviations from the plan above, and why:

- **The protocol lives in `src/shared/`, not `packages/clave-remote-protocol/`.** The Electron build
  resolves `src/shared` already and adding a workspace package would have fought electron-vite for
  no benefit. `packages/clave-remote-protocol/` still exists and holds the generated `keymap.json`,
  which is the artifact that actually has to cross languages. Note these are the first **runtime**
  imports from `src/shared` into the renderer and preload bundles; every previous one was
  `import type`. The build handles it.
- **Origin rejection was added** beyond the plan: any WebSocket handshake carrying an `Origin`
  header is closed with 4003. A native client never sends one, and a browser cannot set an
  `Authorization` header on a WebSocket, so this shuts the DNS-rebinding door completely.
- **Pairing is approved in Settings rather than a modal dialog.** A pending device appears in the
  Devices list live, with Approve and Deny. Cheaper than a dialog flow and leaves a durable roster.
- **Revoked is sticky.** `upsertDevice` preserves an existing status, so a revoked client id cannot
  re-pair by reconnecting under a new device name.
- **`patch` carries no `pinnedGroups`**, so a pinned-group change forces a full `state`. Pinned
  groups change rarely, so this was left alone rather than widening the contract.
- **Session creation from the client (added 2026-08).** The snapshot carries `recentDirs` (the
  Mac's Cmd+N MRU, renderer-supplied) and `homeDir` (merged in main, like the tmux facts) so a
  client can offer real directories; both force a full `state` on change, same as `pinnedGroups`.
  `openSession` is the one command the server normalizes instead of forwarding verbatim: a missing
  `cwd` falls back to the MRU head and then the home directory, and `tmuxMode` is forced on so the
  session the client creates is attachable by the client that asked for it. Advertised as the
  `create` capability.
- **`buildAttachInfo` reads geometry with `execFileSync`.** The CLAUDE.md hazard is `execSync`
  routing through `/bin/sh` and pre-expanding `$PATH`; this passes argv directly with no shell, to a
  `tmuxPath` already resolved through the login shell, with a 2s timeout and a geometry fallback.

Verified (`scratchpad/p1-e2e/protocol-e2e.mjs`, 27/27 against the real built app with an isolated
`--user-data-dir`): loopback-only binding, 4001 on missing and wrong tokens, 4003 on any Origin,
pending devices blocked from commands and attach, 0600 token file, full snapshot on subscribe,
empty patch on a current `sinceVersion` (the iOS resume path), command allowlist enforced before
dispatch, and a remote client creating a session and receiving an attach descriptor whose reported
geometry matched the live tmux window. All three attach modes carry the correct flags: mirror
`ignore-size`, watch `read-only,ignore-size`, takeover none.

The Settings UI was verified visually by driving a second instance: the section renders in place
with access off and approval required by default, the toggle binds the port and reports it live,
and a connecting device appears in the list as pending without a refresh.

---

## 8c. P2 as built

The client lives at `../clave-ios` (local git, no remote). `swift build` clean, **62 tests, 1
skipped, 0 failures**, iOS simulator and device builds both succeed.

```
Sources/ClaveProtocol/     Swift mirror of remote-protocol.ts + keymap.json loader
Sources/ClaveKit/SSH/      NIOSSHTransport on apple/swift-nio-ssh, OpenSSH key parsing, fingerprints
Sources/ClaveKit/Control/  RFC 6455 framing, RemoteClient actor, resume, input gate
Sources/ClaveKit/Model/    KeychainStore, HostKeyStore, HostsStore
Sources/ClaveTerminal/     SwiftTerm subclass: mirror sizing, chord interception, pointer style
Sources/ClaveApp/          SwiftUI shell: hosts, unified activity, trust flow, terminal
```

**The end-to-end run found a real defect in P1.** `broadcastEvent` in `remote-server.ts` had **no
callers**, so the `geometry` event the contract defines was never emitted by anything. The mirror
resync path in §4 was therefore unreachable in practice, and P1's 27/27 verification missed it
because that suite never resized a host window. Fixed by adding `notifyGeometry()` (deduped per
session, no-op with no clients connected) and calling it from `pty:resize` in `pty-handlers.ts`.
The lesson generalises: a protocol message with no producer passes every test that only exercises
consumers.

Demonstrated live, with a user-level sshd on port 2222 and an isolated Clave instance:

- Real ed25519 auth, confirmed in sshd's own log (`Accepted publickey ... ED25519 SHA256:GNyA…`).
- Host-key trust sheet showing a fingerprint byte-identical to the scratch host key.
- Discovery of the control plane's port and token over an `exec` channel, with the honest failure
  case first: pointed at a Mac that had never enabled remote access, the client said so.
- The live session list arriving from the real server, and the selected session rendering real tmux
  output at the host's 139x37 grid.
- **Resync proven**: the Mac's window went 139x37 → 75x25 → 113x33 and the iPad followed each time,
  refitting the font, with a ruler line filling the pane edge to edge and no clipping.

Two caveats recorded honestly:

- ~~**The Keychain does not work from the hand-assembled simulator bundle.**~~ **Resolved in P3,
  and the P2 reasoning was wrong.** P2 concluded there were only two options, both broken:
  declaring `keychain-access-groups` gets the process killed by AMFI at exec, and declaring nothing
  gets `errSecMissingEntitlement`. A third option does exist. For a simulator destination Xcode
  writes the real entitlements to `Clave.app-Simulated.xcent` and links them into the binary as a
  `__TEXT,__entitlements` section while leaving the code signature ad-hoc with an empty
  entitlements blob: AMFI on the host sees nothing to reject, and the simulator's securityd sees
  the full entitlements. The container fallback is deleted (`grep -r targetEnvironment(simulator)
  Sources/` is empty) and the key round-trips through the real Keychain across relaunch and
  reinstall. Verified independently: both the simulator and device `.xcent` carry
  `keychain-access-groups: [UR4RG553ZN.io.codika.clave.ios]`.
- Text entry during the simulator drive needed `osascript`, because the iOS Simulator exposes text
  fields read-only over the accessibility API. A UI-test target is the right answer later.

---

## 8d. P3 as built

`swift build` clean, **148 tests, 1 skipped, 0 failures**, and `xcodebuild` succeeds for both an
iPad simulator and `generic/platform=iOS` with real signing.

**Xcode project.** `Clave.xcodeproj`, authored with a `PBXFileSystemSynchronizedRootGroup` so it
picks up new files without edits (proven under fire: it absorbed files three other agents created
mid-run). Local SwiftPM package reference, so `Package.swift` needed no change and the SwiftPM path
still works. `build-sim.sh` now drives `xcodebuild`. One-time machine setup:
`xcodebuild -downloadComponent MetalToolchain`, because SwiftTerm ships a `.metal` shader.

**Pointer and mouse.** Wheel-to-button with a coalescing rule of one report per cell height, at
most one per 1/60s, residual clamped to ±3 cells, momentum travel discarded. Measured: 120
callbacks over 1s produce 24 reports rather than 120, and a 10,000pt fling produces 3 reports then
silence. Hover motion for 1003, secondary click (native menu by default, forwarding as a setting),
Option-forced local selection, pasteboard copy, pinch to resize, two-finger scrollback.

**Key repeat, solved.** The key-up hook is one link up the responder chain, since SwiftTerm's
`pressesEnded` calls `super`, which forwards to the superview. Built fail-safe because it types
into a live agent: four independent stops (key-up relay, any other key down, a `GCKeyboard`
liveness veto that never reads absence of signal as consent, a 5s watchdog), plus cancellation on
background and resignation, and it stays **disarmed unless the relay is confirmed present**, so a
misconfigured mount degrades to no-repeat rather than to a runaway.

**Accessory bar and compose sheet.** The bar consults the shared `matchChord` first and adds only
the VT encodings the table deliberately omits, so no second chord table exists. Sticky modifiers
cycle off → armed → locked. The compose sheet sends one bracketed-paste block when DECSET 2004 is
active and bare text when it is not, verified in both states with flags and quotes uncorrupted.

**Transcript.** `capture-pane` over the P2 `exec` channel, argv always an array, with the target
re-validated against `clave-[A-Za-z0-9_-]+` even though the host already validated it. Live proof:
3,201 lines fetched across 7 pages with contiguous line tags and no gap or overlap, 742 styled runs
across 69 colours including truecolour, multibyte and box drawing intact, and a deliberate 8 KB
ceiling correctly refusing an oversized page. Native selection, system find bar, and share.

### Traps found while building it

- **`Terminal.encodeButton` maps buttons 6 and 7 to `0`**, so horizontal trackpad scroll would
  reach the application as a left click. P3 ships its own encoder with a test pinning agreement
  with upstream everywhere upstream is correct.
- **SwiftTerm synthesises arrow keys from a finger drag** (`panSelectionHandler`), violating §6.2's
  "tap does not move the cursor" rule from inside the library. Intercepted and refused unless a
  selection exists.
- **tmux clamps both ends of a `capture-pane` range**, so a range older than the history returns
  the oldest line again rather than nothing. A fetch therefore cannot detect end-of-history;
  pagination must decide.
- **`GCKeyboard.coalesced` is non-nil on the simulator** with no hardware keyboard attached, so
  that particular repeat stop is effectively untested. It fails safe (degrading to the watchdog),
  but it belongs on the hardware list below.

### Still needs real hardware

Everything below was either synthesized or not exercised, and is not claimed as working:

- UIKit recognising an indirect trackpad scroll as a pan (the wheel path's first mile).
- A physical `pressesEnded` reaching the key-up relay.
- `GCKeyboard` liveness reporting truthfully.
- Trackpad momentum: iOS exposes no public momentum phase to a pan recogniser, so the phase is
  modelled and never produced today. The rule is to never synthesise a deceleration tail from
  velocity.

A Magic Keyboard and half an hour would close all four.

---

## 8e. UAT round 1, and what it found

The first real run against a physical iPad over Tailscale failed. Four defects, none of which the
automated suites could have caught, because every one of them lived in a timing or lifecycle window
that a loopback test never opens.

**1. Empty terminals in the desktop (the worst one).** React StrictMode double-mounts every
component in dev. The first mount spawned the PTY and tmux painted into it; that instance was then
disposed, taking the paint with it; the second mount called `start()`, found a live PTY, and merely
resized it **to the size it already was**. The kernel raises no SIGWINCH for an unchanged winsize,
so tmux never repainted and the pane stayed blank until the agent spontaneously printed something.
Measured directly: a same-size resize returns **0 bytes**. "Most sessions blank, a few fine" was the
race being won when a child's output happened to land after the remount.
Fixed with a bounded 256 KB replay tail per session (`src/main/pty-replay.ts`), trimmed on whole
chunk boundaries so a repaint cannot begin mid-escape-sequence, replayed when a terminal attaches to
an already-running session. Chosen over forcing a SIGWINCH with a ±1 resize, which would make agent
TUIs reflow and would restore nothing for a plain shell.

**2. "Timed out waiting to subscribe", while the session list was visible.** A reply-beats-the-waiter
race in the Swift client: `state` arrived before the continuation parked, so it was applied to the
model and then dropped as an answer. The list appeared; fifteen seconds later the user was told it
had timed out. Three sites had the same bug (`WebSocketConnection.open`, `RemoteClient.subscribe`,
`RemoteClient.establish`); a fourth, `roundTrip`, already guarded the window, which is direct
evidence the hazard was known and simply missed elsewhere.
A desktop bug made the race winnable rather than theoretical: `handleHello` assigned `state.clientId`
before `upsertDevice`, and the roster listener then sent a **second** `welcome` to the socket that
had just said hello, which the client read as an approval push.

**3. Approval needed a force-quit.** `LiveHostDriver` only called `subscribe()` when pairing was
already `approved`, but the client resubscribes on an approval welcome only if a subscription was
ever requested. A pending device never recorded the intent, so approval landed and nothing happened.
The code comment asserted the opposite of what the code did.

**4. Attach failed silently, forever.** A `guard let transport else { return }`, failures written to
a field the pane never rendered, and a transcript whose only error case read "This session is
opening". With the host down, a dead attach claimed to be opening indefinitely. Replaced with an
explicit `SessionAttachPhase` (idle / attaching / attached / failed / ended) surfaced as a banner
with a reason and a retry, and a transcript that distinguishes the four states.

**Not reproduced: "Ignored an unreadable message from the Mac."** Framing was cleared under 1-byte,
7-byte, 1280-byte (Tailscale's MTU), random, and header- and length-boundary-straddling chunking,
including the 64-bit length path; and a real 10.8 KB twenty-session `state`, plus every message type
the server actually emits, decodes from checked-in captures. The cause remains unknown, so the error
now reports the message type, byte count, the decoder's field path and reason, and a redacted
excerpt. If it recurs, one screenshot will name it.

**The lesson worth keeping.** All four hid behind the same thing: tests that used loopback and a
single fast happy path. The permanent fixture added here (`ChunkedForwardedChannel`) delivers bytes
in adversarial chunks and lets a scripted host answer before the caller is ready. That is the shape
of test this project needed from the start.

---

## 8f. Chat mode, as built

A fourth per-session view next to Mirror/Takeover/Watch: a structured chat rendering of a Claude
Code session, driven by the session's own transcript instead of PTY bytes. On cellular this is the
difference between a tool call arriving as one ~300-byte JSON event and arriving as a screenful of
ANSI. Shipped across both repos in one change, per the mirror rule.

**Where the events come from.** Clave already launches every Claude session with `--session-id`, so
main knows the CC session UUID, and the transcript lives at
`~/.claude/projects/<cwd with [/.]→->/<uuid>.jsonl`. But that id ROTATES on `/clear` and `--resume`,
and nothing in Clave updated it afterwards (the sidecar goes stale; `session-export-handlers.ts`
documents the cascade it grew to cope). So the SessionStart hook now archives its payload into the
same per-session event log the Notification hook uses (`buildClaudeHookSettingsArg`), and
`chat-manager.ts` records the payload's `transcript_path` as a persisted override
(`<userData>/chat-transcripts.json`), because the agents outlive the app inside tmux. Resolution
order: hook-reported path first, id-anchored derivation second, and never mtime guessing — with
parallel sessions in one project, "newest file" is how you tail a sibling's conversation.

**Host side** (`src/main/`):

- `chat-transcript.ts` — pure normalization of transcript lines into the small wire schema
  (`RemoteChatEvent`): user/assistant text, thinking, `tool_use` + `tool_result` (correlated by id),
  meta lines, with per-kind body caps (a 3 MB base64 image inside a tool result is exactly what
  chat mode exists to avoid; images cross as `[image]`). Sidechain (subagent) traffic is filtered.
  Entry types we know and skip are an explicit list, so a genuinely NEW type crosses the wire as
  `kind: 'unknown'` — the client's cue that the schema drifted and Mirror is the honest fallback.
  Locked by `npm run verify:chat` (the `verify-keymap`/`verify-pty` house pattern).
- `chat-manager.ts` — the tailers (byte-offset incremental reads, partial-line carry, fs.watch plus
  a poll net, 2 MB bounded backfill ending on a whole line), the override persistence, refcounted
  subscriptions, and the input path: `chatInput` wraps the text in a bracketed paste and submits
  with Enter **as a separate write 150 ms later** — measured: an Enter in the same write as the
  paste races the TUI's render loop and sometimes leaves the text sitting unsubmitted in the
  composer. `chatKey` is a host-side name→bytes allowlist (escape, shift-tab, tab, enter, arrows,
  1-3), so no byte table needed mirroring into Swift.
- `remote-server.ts` — four new client messages (`chatSubscribe`/`chatUnsubscribe`/`chatInput`/
  `chatKey`), three new server messages (`chatSnapshot`/`chatEvents`/`chatReset`), the `chat`
  capability, per-socket subscription sets released on close, and a `chatAvailable` fact merged
  into every session like `tmuxName`. Old clients never chat-subscribe so they never see a chat
  message; old hosts lack the capability so the client never shows the option. Protocol stays v1.

**When the transcript rotates** (`/clear`, resume): the SessionStart hook fires with the new path,
the tailer re-points, and subscribers get `chatReset` — resubscribe for a coherent backfill. The
same replace-over-merge rule as the session model, for the same reason.

**iPad side**: `SessionViewMode` (mirror/takeover/watch/chat) replaces the per-session
`RemoteAttachMode` in the shell — chat is deliberately NOT a wire attach mode, because it opens no
tmux channel at all (switching to chat detaches the terminal channel; switching back re-attaches).
`ChatSessionModel` in ClaveKit folds events into rows (results into their calls, dedupe by id
because a live batch can legitimately repeat the backfill's tail), `ChatPane` renders them with a
composer, Esc/Mode quick keys, prompt-answer keys while `promptWaiting`, a drift banner offering
Mirror when unknown events appear, and a `ChatPhase` so an empty log can say whether it is loading,
live, or refused (the `SessionAttachPhase` lesson, reapplied). Chat subscriptions die with the
socket, so the runtime resubscribes every chat-viewed session when the link comes back.

**Verified end to end** (scratchpad `chat-e2e.mjs`, 19/19 against the real built app and a REAL
`claude` session): capability advertised; unknown-session and plain-terminal subscribes refused
with reasons; `chatAvailable` facts correct both ways; the SessionStart hook recording the
override; a prompt sent over the control plane coming back from the tail as a user event and then
the model's actual reply as an assistant event; `/clear` producing `chatReset` and a fresh
backfill without the old exchange; no tmux sessions leaked. The wire fixtures those runs produced
are checked into the iOS repo (`Fixtures/wire-messages.jsonl`), so the Swift decoder is tested
against bytes the host actually sent — 179 tests, 0 failures, simulator and device builds green.

Still needs on-device UAT: the chat pane's keyboard/scroll feel, and a real cellular round trip.

---

## 9. Later phases

- **Push notifications.** Local notifications while connected land in P4. Real lock-screen alerts
  need APNs, and the APNs signing key cannot ship inside the desktop app, so proper push requires a
  small relay. An interim that works today: have the host service post to ntfy or Pushover, roughly
  20 lines, giving real alerts with no infrastructure. Worth checking against whatever already
  satisfies the existing "ping me on my iPhone" rule.
- **Non-tmux sessions.** Sessions started with tmux mode off report `remotable: false` with a
  reason. Mirroring the main-process PTY stream through the control plane would cover them; it is
  real work and belongs behind v1.
- **File tree, git panel, `.clave` launching.** The commands already exist in the dispatcher, so
  this is mostly iPad UI.
- **iPhone layout.** The terminal work all carries over; the navigation does not.
- **Secure Enclave keys.** A P-256 key in the Secure Enclave maps onto `ecdsa-sha2-nistp256`, but
  `swift-nio-ssh` expects a `P256.Signing.PrivateKey` rather than an enclave-backed signer. Treat
  as a spike, with Keychain-stored Ed25519 as the shipping default.

---

## 10. Risks, named

Rewritten after P0. Retired risks are kept, struck through, so the record shows what was actually
tested rather than what was feared.

| Risk | Severity | Handling |
|---|---|---|
| **iOS backgrounding drops the SSH connection; control-channel resume is unspecified** | **High** | Now the first task of P2. Sessions recover via tmux reattach (~19 KB, measured). The control plane needs a monotonic state version so the client asks "what changed since N" rather than refetching |
| `SwiftTerm.resize()` calls `softReset()`, clearing bracketed paste and mouse modes on every mirror resync | High | Call `terminal.resize(cols:rows:)` then `sizeChanged(source:)`. Cover with a test that asserts modes survive a resize |
| A stale mirror is silently clipped after a host resize | High | Measured and understood. Host pushes geometry, client re-issues `window-change`; full fidelity returns immediately |
| Key repeat runaway on `pressesCancelled` sends stray keys to an agent | Medium | SwiftTerm's repeat engine cancels on `pressesEnded`; verify `pressesCancelled` and fix in the subclass. Paired with discard-on-disconnect |
| SSH transport depends on a third-party NIOSSH fork | Medium | Build on `apple/swift-nio-ssh` directly (§7.2). If Citadel is used instead, vendor both at pinned SHAs and audit the diff |
| Swift 6 concurrency: SSH types are not `Sendable` | Medium | `SSHSession` actor per channel vending a Sendable façade; read loop stays inline |
| Clean session exits surface as `ChannelError.alreadyClosed` | Medium | Swallow it on the normal-exit path, or every clean exit looks like a disconnect |
| tmux config changes need a server restart | Medium | Extend `reconcileTmuxBindings` (`pty-manager.ts:413-425`). P0 hit this for real and it silently invalidated a whole test run |
| Keymap drift between TS and Swift | Medium | Shared `keymap.json` plus tests on both sides; add to the CLAUDE.md mirror rule. Revisit if we adopt the Kitty protocol instead |
| Mirroring a wide host grid needs very small type on an 11-inch iPad in portrait | Medium | 180 columns lands at 7.5pt. Offer "match host width" versus "fit readable text" rather than assuming Mirror always wins |
| Cellular latency makes typing feel bad | Medium | Documented honestly; compose sheet reduces per-keystroke exposure |
| App Store review of an SSH client | Low | Termius, Blink, and Prompt all ship; no downloaded code, no interpreter |
| Remote access grants full session control | High | Off by default, loopback bind, pairing with revoke, token in a 0600 file |
| ~~`ignore-size` behaves differently than documented~~ | ~~High~~ | **Retired.** Verified on tmux 3.7b: protects host geometry, permits input, and `read-only` genuinely blocks it |
| ~~Citadel lacks PTY resize or direct-tcpip~~ | ~~Medium~~ | **Retired.** Both live-tested working, including three concurrent ptys plus a forward on one connection |
| ~~We must build a key-repeat engine~~ | ~~Medium~~ | **Retired.** SwiftTerm ships one (0.4s / 0.1s) |

---

## 11. House rules that apply

- No em-dashes in UI copy, and no "X, not Y" phrasing (`~/.claude/CLAUDE.md`).
- Verify renderer changes with the **Playwright Electron MCP** (`CLAUDE.md`).
- New shared enums or wire fields get the same mirror treatment as the `.clave` enums: change every
  copy in one commit, and extend the rule in `CLAUDE.md` to cover `clave-remote-protocol`.
- Use Heroicons for the Settings tab, and existing `main.css` semantic classes rather than inline
  Tailwind.
