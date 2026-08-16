# P0 spike results

Empirical answers to the four assumptions that carry the iPadOS client design
(`docs/ipad-remote-client.md`). Everything here was executed, not researched. Harnesses live in
the session scratchpad under `p0-tmux/`, `p0-ssh/`, and `p0-swiftterm/`.

Environment: macOS 26.5, tmux 3.7b (Homebrew), Swift 6.3.3, Xcode 26.6, node-pty 1.1.0.

All tmux work ran on socket `clave-spike`. The user's live socket `clave` (13 real sessions) was
never touched, and was verified intact afterwards.

## Verdict

**P0 passes. The architecture holds. Proceed to P1.** Four changes to the plan came out of it:

| # | Change | Section |
|---|---|---|
| 1 | Mirror mode must size the iPad's pty to the **host's** grid; `ignore-size` alone clips | §4 |
| 2 | Build the SSH transport on **Apple's** swift-nio-ssh, not Citadel's third-party fork | §7.2 |
| 3 | Key repeat is already implemented upstream; delete that work item | §5.2 |
| 4 | `SwiftTerm.resize()` calls `softReset()` and must not be used on the mirror resync path | §7.1 |

Nothing found invalidates the two-plane design, and the riskiest assumption in it — many pty
channels plus a port forward multiplexed over one SSH connection — was verified working live.

---

## P0-A — tmux multi-client sizing

**Verdict: the design works, but the original Mirror-mode specification was wrong and is now
corrected.**

Harness: `p0-tmux/sizing-spike.js` and `p0-tmux/mirror-spike.js`. Both drive real tmux clients
through node-pty at exact grid sizes, against the config generated from `pty-manager.ts:221-253`.

### Results

| # | Test | Result |
|---|---|---|
| 1 | Desktop client attaches at 180x50 | window 180x50 |
| 2 | iPad attaches **plain** at 96x30 | window becomes **96x30** — desktop geometry destroyed, problem reproduced |
| 3 | iPad detaches | window returns to 180x50 |
| 4 | iPad attaches with `-f ignore-size` | window stays **180x50** — desktop protected |
| 5 | `ignore-size` client can still type | yes, input reaches the pane |
| 6 | Narrow `ignore-size` client receives the full 180-col grid | **no — clipped to its own width** |
| 7 | `-f read-only,ignore-size` blocks input | yes, Watch mode is real |
| 8 | Watch client leaves geometry alone | yes |
| 9 | Desktop resize still wins while iPad clients attached | yes, 200x55 |

Test 6 is the one that changed the design. A 96-column client with `ignore-size` receives columns
1-96 of a 180-column window and never learns the rest exists. It is clipped, not scaled and not
pannable.

Follow-up (`mirror-spike.js`) isolated the cause:

| Client size | Flag | Window | Client receives |
|---|---|---|---|
| 96x30 | none | 96x30 | full content, reflowed to 96 (the window shrank) |
| 96x30 | `ignore-size` | 180x50 | **clipped**: A=92, B=0 of a 90-A + 90-B ruler |
| 180x50 | `ignore-size` | 180x50 | **full**: A=92, B=92 |

Clipping tracks the client's own width and is independent of the flag. Hence the corrected Mirror
mode: **size the iPad's pty to the host's window, and pass `ignore-size` as a guard.**

Two further confirmations:

- **Stale mirrors are silently clipped.** Desktop grown to 200x55 with the mirror still at 180
  wide: the ruler truncated from 100 to 82 characters. After the client re-issued `window-change`
  to 200x55, full fidelity returned and the desktop was undisturbed. Geometry push plus client
  resync is mandatory.
- **Control mode is a viable alternative data plane.** `tmux -CC attach` does not reflow the
  desktop and pushes geometry changes unprompted:
  `%layout-change @0 bfbd,150x45,0,0,0`. Not needed for v1, since our own control plane knows the
  geometry, but it is the right fallback if multi-pane rendering is ever wanted.

---

## P0-A3 — mouse reporting through Clave's tmux config

**Verdict: fully working. 7/7.** Harness: `p0-tmux/mouse-spike.js`.

This matters because Clave conditionally rebinds the wheel on `#{mouse_any_flag}`
(`pty-manager.ts:238-239`), which is exactly where a remote client's mouse could get swallowed.

| # | Test | Result |
|---|---|---|
| 1 | App has not requested tracking | `mouse_any_flag=0` |
| 2 | Wheel with no app tracking | enters tmux copy-mode, i.e. scrollback |
| 3 | App sets DECSET 1000/1002/1006 | tmux observes `mouse_any_flag=1` |
| 4 | Press / drag / release as SGR 1006 | all three arrive at the app intact |
| 5 | Wheel while app wants the mouse | forwarded to the app, copy-mode **not** entered |
| 6 | Secondary click (button 2) | arrives at the app |
| 7 | `extended-keys` | `on` |

So the iPad can send raw SGR 1006 and Clave's existing config routes it correctly in both
directions: to the app when the app wants it, to scrollback when it does not.

### A trap this exposed, worth keeping

The first run of this spike passed 5/7 for the wrong reason. The harness started the tmux server
without `-f CONF`, so it came up under tmux defaults with `mouse off` — and with mouse off, tmux
**forwards mouse bytes uninterpreted**, so the "mouse reaches the app" assertions passed while
proving nothing. This is the same "config is only read when the server first starts" hazard already
documented at `pty-manager.ts:407`.

Any test in this area must assert `show-options -gv mouse` is `on` before trusting a result. The
corrected harness does exactly that and prints it as a config check.

---

## P0-D — attach-to-first-paint

**Verdict: reattach is effectively free. Foreground-and-resync is the right lifecycle.**

Harness: `p0-tmux/latency-spike.js`, run under Clave's config.

| Scenario | TTFB (local) | Bytes | Modelled LTE | Modelled slow link |
|---|---|---|---|---|
| Idle shell prompt, 180x50 | 7ms | 1.0 KB | 61ms | 155ms |
| Full colour repaint, 180x50 | 7-37ms | 19.1 KB | 73ms | 252ms |
| Full colour repaint, 96x30 | 10-18ms | 7.3 KB | 65ms | 189ms |

A worst-case full-screen repaint of a busy agent session is ~19 KB, which is one RTT plus about
100ms of transfer even on a 1.5 Mbps link. Local time is single-digit milliseconds.

Consequences for the design:

- Reattaching every open session on foreground is cheap enough to do unconditionally.
- The plan's "discard keystrokes typed while disconnected" policy costs the user nothing, because
  the reconnect itself is sub-second. There is no reason to take on the risk of replaying buffered
  input into a live agent.
- Payload scales with grid area, so Mirror mode at a large host grid costs ~2.6x a small one. Still
  trivial.

Caveat: these are local-pty numbers. SSH adds encryption framing (small) and one network RTT before
the first byte, which the modelled columns include. They do not model packet loss on a bad cellular
link.

---

## P0-A4 — `capture-pane` as the transcript source

**Verdict: works, but must be paginated.** Harness: `p0-tmux/transcript-spike.sh`.

The plan (§6.3) replaces tmux copy-mode with a native transcript sheet fed by `capture-pane`.
Against a 3000-line pane of coloured, box-drawing, multibyte output:

| Range | Lines | Plain | With colour (`-e`) |
|---|---|---|---|
| `-S -1000` | 1050 | 106 KB | 122 KB |
| `-S -5000` | 3003 | 303 KB | 350 KB |
| `-S -50000` | 3003 | 303 KB | 350 KB |

UTF-8 and box drawing survive intact (3001/3001 lines kept `│` and `▸`), so the transcript renders
faithfully rather than as the `_` soup the non-UTF-8 tmux path produces.

The size is the caveat: a full history is ~350 KB, which is ~2 seconds on a 1.5 Mbps link. So the
transcript view should fetch `-S -500` first and page backwards on demand, and the SSH channel
should have compression enabled — this content is highly compressible.

`history-limit` is 50000 (`pty-manager.ts:226`), so the ceiling is bounded and known.

---

## P0-B — SSH library validation

**Verdict: the SSH design is sound and live-verified. The library choice changes.**

Tested against a real `sshd` (non-root, port 2222, scratch host key), with real tmux, a real pty,
and a real port forward. Artifacts: `p0-ssh/`, iOS build harness at `p0-ios/`.

| # | Requirement | Result | Symbol | Evidence |
|---|---|---|---|---|
| 1 | Interactive channel + pty-req | **yes** | `SSHClient.withPTY(_:environment:perform:)` | live-tested, full tmux TUI redraw |
| 2 | `window-change` on a live channel | **yes** | `TTYStdinWriter.changeSize(cols:rows:...)` | live-tested: resized 80x24 to 200x50, tmux confirmed `SIZE=200x50` |
| 3 | `direct-tcpip` forwarding | **yes** | `SSHClient.createDirectTCPIPChannel(using:initialize:)` | live-tested, `HTTP/1.0 200 OK` from a server-side listener |
| 4 | ed25519 / RSA / keyboard-interactive | **yes / yes / no** | `.ed25519(username:privateKey:)`, `.rsa(...)` | ed25519 live-tested, RSA compiled, kbd-interactive absent upstream |
| 5 | Host-key callback for TOFU | **yes** | `NIOSSHClientServerAuthenticationDelegate.validateHostKey` | live-tested: computed fingerprint matched `ssh-keygen -lf` exactly; a wrong pin hard-failed |
| 6 | Builds for iOS | **yes** | — | `xcodebuild -destination 'generic/platform=iOS'` succeeded, arm64-apple-ios17.0 |

**Multiplexing, the thing most at risk, works.** Three concurrent `withPTY` channels plus a live
direct-tcpip forward over one `SSHClient`, each pty resized independently and correctly
(100x30, 110x31, 120x32, all confirmed by tmux). The two-plane architecture in §2 is validated.

### The library finding

Citadel **does not depend on Apple's swift-nio-ssh.** Its `Package.swift:20` pins
`github.com/Wellz26/swift-nio-ssh` at `"0.3.4" ..< "0.4.0"` (resolved to 0.3.6), a community fork
maintained by an individual, carrying real divergence from upstream. Verified directly, not taken
on report.

This matters because that package is the layer holding the user's SSH keys to their development
machines, and the pin is a floating version range rather than a SHA.

I then checked Apple's upstream (`apple/swift-nio-ssh`, HEAD `3ec2814`, 2026-07-28, actively
maintained) and **every load-bearing primitive the spike exercised is present there**:

| Primitive | Upstream location |
|---|---|
| `SSHChannelRequestEvent.PseudoTerminalRequest` | `Child Channels/ChildChannelUserEvents.swift` |
| `SSHChannelRequestEvent.WindowChangeRequest` | `Child Channels/ChildChannelUserEvents.swift` |
| `SSHChannelType.DirectTCPIP` | `Child Channels/SSHChannelType.swift` |
| `NIOSSHClientServerAuthenticationDelegate` | `Keys And Signatures/ClientServerAuthenticationDelegate.swift` |
| ed25519 client auth | `NIOSSHPrivateKey.init(ed25519Key:)` |

Citadel is an ergonomic wrapper over primitives we already have first-party.

**Corrected during P2.** This section originally claimed host-key serialization was internal-only
upstream and would need a ~10 line shim. That was wrong: `String.init(openSSHPublicKey:)` is
**public** at `NIOSSHPublicKey.swift:461` and returns the same wire bytes, so the TOFU fingerprint
needs no shim at all. The original grep looked at the `NIOSSHPublicKey` struct and missed the
`String` extension below it. P2 verified the resulting fingerprint byte-for-byte against
`ssh-keygen -lf` on a live handshake.

The real gap upstream is the opposite one, and P0-B did not spot it: NIOSSH has **no OpenSSH
private-key parser** (`Curve25519.Signing.PrivateKey(sshEd25519:)` was Citadel's own addition).
P2 wrote `OpenSSHKey.swift`, ~230 lines of bounds-checked `openssh-key-v1` read and write for
ed25519, verified by round-tripping against `ssh-keygen -y`. Encrypted keys are refused explicitly
rather than half-supported. Net effect on the estimate is roughly neutral.

### Recommendation

**Build the transport directly on `apple/swift-nio-ssh`,** using Citadel's source as the reference
implementation for the channel plumbing. Roughly 600 LOC plus the ~10 line fingerprint shim, so
about one extra week in P2. For an SSH client that holds keys to the user's machines, keeping the
security-critical dependency first-party and actively maintained is worth a week.

If schedule pressure wins, Citadel is acceptable **only** with both repositories vendored at pinned
SHAs, never a floating range, plus a diff audit against upstream.

Keyboard-interactive is unavailable on either path (NIOSSH's auth state machine is `internal` and
its offer enum has no case for it; ~300-350 LOC to add, complicated by SSH message id 60 being
context-dependent). Do not build it. Public-key auth is the normal path for one's own Mac.

### Three implementation traps

1. **Nothing in Citadel's surface is `Sendable`**, which bites immediately under Swift 6.
   `SSHClient`, `TTYStdinWriter`, and `TTYOutput` all needed `@unchecked Sendable` boxes, and the
   read loop must stay inline inside the `withPTY` closure. Budget for a small `SSHSession` actor
   that owns each channel and vends a Sendable façade. This applies to a hand-rolled layer too:
   design the actor boundary first.
2. **`withPTY` closes the channel on both success and error**, so a normally-exiting remote shell
   throws `ChannelError.alreadyClosed` out of `withPTY`. Unhandled, every clean session exit looks
   like a spurious disconnect.
3. **Backgrounding was not tested and is now the largest open unknown.** iOS suspends sockets on
   app switch, so the single long-lived SSH connection drops every time. tmux makes the *session*
   side recoverable, but the direct-tcpip control channel needs its own resume logic, including
   how the client resynchronises state it missed while suspended. See "Remaining unknowns" below.

## P0-C — SwiftTerm fidelity

**Verdict: SUFFICIENT, no fork.** All seven questions answered by building an iPad app, running it
on an iPad Pro 11-inch (M5) simulator, and screenshotting the probe output. Artifacts:
`p0-swiftterm/SpikeApp`, screenshots in `p0-swiftterm/build/`.

Upstream is much further along than SwiftTerm's reputation suggests: Metal renderer, Kitty keyboard
protocol, `UITextInput`, and `UIPointerInteraction` are all already present.

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Mouse reporting | Complete. 1000/1002/1003 tracked, SGR 1006 verified byte-for-byte: press `ESC[<0;10;5M`, release `ESC[<0;10;5m`, drag `ESC[<52;21;8M`, wheel `ESC[<64;4;4M`. `Terminal.mouseMode` is public, `mouseModeChanged` is delegated. | ran-it |
| 2 | Keyboard interception | **The seam exists.** `pressesBegan` is `open`, `send(_:)` is `public`. A subclass emitting our desktop bytes was verified live. SwiftTerm also skips all Cmd chords in non-Kitty mode, so `keyCommands` works as a second seam. | ran-it |
| 3 | Key repeat | **Already implemented** by SwiftTerm: `Timer`, 0.4s initial / 0.1s interval, armed in `pressesBegan` on all four encoder paths, cancelled in `pressesEnded`. | read-source |
| 4 | Pointer | `UIPointerInteraction` installed but only for link hover. `styleFor` is **not** implemented, so no pointer shape over the grid, and hover motion is never forwarded (breaks mode 1003). | ran-it |
| 5 | Selection | Full API. `getSelectedText()` returned the expected string, `copy(nil)` reached `UIPasteboard`. Touch selection uses SwiftTerm's own handles, **no system magnifier**. | ran-it |
| 6 | Mirror-mode sizing | **Works exactly.** Requested 180x50, got 180x50 at 7.5pt Menlo (cell 4.52x9.00) in an 812x450 frame. iOS `getEffectiveWidth` reserves no scroller, so the arithmetic is exact. | ran-it |
| 7 | Paste | Bracketed paste correct (`ESC[200~...ESC[201~` with 2004 on, plain with it off). OSC 52 parsed and delegated both directions. | ran-it |

Both screenshots were read back and independently confirm the claims, including the `[CUP 40;150]`
marker landing at column 150 of a 180-column grid, and the subclass log lines
`Cmd+Left -> C-a => \x01`, `Cmd+Bksp -> C-u => \x15`, `Opt+Bksp -> ESC DEL`.

### Gaps, all closeable by subclassing

| Gap | Fix | Effort |
|---|---|---|
| No pointer shape over the grid | Implement `pointerInteraction(_:styleFor:)`, switch I-beam / arrow on `mouseMode` | ~1h |
| Mode 1003 hover motion never reported | Own `UIHoverGestureRecognizer` calling `terminal.sendMotion(...)` | ~2h |
| **Trackpad scroll never becomes button 4/5** — the `UIScrollView` eats it | `UIPanGestureRecognizer` with `allowedScrollTypesMask = .all`, `allowedTouchTypes = [.indirectPointer]`; drive `isScrollEnabled` off `mouseMode` | ~3h |
| No secondary-button reporting | `.indirectPointer` gesture reading `event.buttonMask` | ~2h |
| Opt+Backspace sends `ESC BS`, not `ESC DEL`; Cmd+Backspace dropped | Our chord table in the `pressesBegan` subclass, which runs first | ~4h for full parity |
| No system magnifier on touch selection | Not subclassable (SwiftTerm draws its own handles). Fork only if it ever matters. | ~2d, deferred |

Total to close everything architecture-critical: **about 2-3 days.**

### Findings that change the plan

1. **`TerminalView.resize()` calls `terminal.softReset()`.** Mirror mode resyncs on every host
   resize, so state gets cleared mid-session, repeatedly. Call `terminal.resize(cols:rows:)`
   directly and then `sizeChanged(source:)`. This is the single most likely bug to bite the
   implementation.

   **Corrected during P2** (verified at `SwiftTerm/Sources/SwiftTerm/Terminal.swift:4571-4592`):
   in this revision `cmdSoftReset` does **not** touch `bracketedPasteMode` or `mouseMode`, which is
   what this finding originally claimed. What it does clear is **DECCKM** (`applicationCursor`),
   plus `applicationKeypad`, the scroll region, origin/insert/wraparound, and charset. The
   conclusion is unchanged and the stakes are if anything higher: losing DECCKM breaks every arrow
   key in vim, less, and tmux copy-mode. The P2 implementation snapshots all three modes so that a
   future widening of `cmdSoftReset` fails loudly rather than silently.
2. **The Kitty keyboard protocol is already implemented** (`KittyKeyboardEncoder.swift`,
   `terminal.keyboardEnhancementFlags`). That is a better answer to unambiguous modifier reporting
   than a hardcoded byte table, and it needs a decision now, because `pressesBegan` has two
   completely separate encoder paths and our interception must handle both.
3. **`TerminalView` is a `UIScrollView`.** Mirror mode and wheel reporting both fight it. Expect
   `isScrollEnabled` to be driven by `mouseMode`.
4. **A Metal renderer exists** (`setUseMetal(_:)`), untested here. Likely relevant for a 180x50
   grid repainting at tmux speed.
5. **An accessory bar already ships** (`iOSAccessoryView.swift`, `TerminalAccessory`) with Ctrl,
   Esc, and arrows. §5.3 gets a running start rather than starting from zero.
6. **Readability caveat.** Mirroring a 180-column host grid on an 11-inch iPad in **portrait**
   needs 7.5pt type. It rendered cleanly on Retina, but it is small. Landscape, or a host pane
   under ~140 columns, is the comfortable case. Worth a "match host width" versus "fit readable
   text" choice in the UI rather than assuming Mirror is always right.

---

## Remaining unknowns

P0 answered what it set out to answer. Three things it did not, ranked by risk:

1. **Backgrounding and reconnect (highest).** iOS suspends sockets on app switch, so every
   foregrounding is a full reconnect. The session side is recoverable because tmux holds the state
   and reattach costs ~19 KB (P0-D). The **control channel** is the unsolved half: it needs resume
   semantics, and the client needs to resynchronise the session model it missed while suspended.
   The protocol in §3.2 should carry a monotonic state version so the client can ask "what changed
   since N" instead of refetching everything. Worth a spike at the start of P2.
2. **Metal renderer under load.** SwiftTerm ships `setUseMetal(_:)`, untested here. A 180x50 mirror
   grid repainting at tmux speed is the case that would justify it.
3. **Real hardware.** Everything ran on a simulator. Trackpad scroll phases, pointer hover, and
   key repeat with a physical Magic Keyboard behave differently enough that the input work in P3
   should be validated on a real iPad early rather than at the end.

## Reproducing

```
node p0-tmux/sizing-spike.js      # multi-client sizing, ignore-size, read-only
node p0-tmux/mirror-spike.js      # clipping cause, resync, control mode
node p0-tmux/mouse-spike.js       # SGR 1006 through Clave's tmux config
node p0-tmux/latency-spike.js     # attach-to-first-paint and payload size
zsh  p0-tmux/transcript-spike.sh  # capture-pane transcript sizing
```

Each script creates and destroys its own tmux server on socket `clave-spike`. Any test touching
mouse behaviour must first assert `show-options -gv mouse` is `on`, or it will pass for the wrong
reason.
