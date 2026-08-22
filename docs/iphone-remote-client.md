# Clave for iPhone — remote client plan

The iPadOS client (`codika-io/clave-ios`, plan: `docs/ipad-remote-client.md`, built through P4 + chat)
comes to the iPhone with full feature parity, reshaped for a screen a quarter the size with no
trackpad and no room for three columns. This is a client-only phase: **the host service, the wire
protocol, and the keymap need no changes.** Everything below happens in the `clave-ios` repo.

§9 of the iPad plan predicted the shape of this work in one line: "The terminal work all carries
over; the navigation does not." That held up under investigation, with one addition — the input
story changes too, because the iPad plan's §6 assumed a pointer exists somewhere, and on iPhone one
never does.

Three product decisions anchor the plan, in the order they were asked for:

1. **Agent sessions are compose-first.** In a Claude (or Codex/Antigravity) tmux session, text
   entry goes through the Compose sheet; tapping the terminal does not raise the software keyboard,
   so the mirror never jumps under a keyboard animation. A key on the accessory bar opts back into
   the raw keyboard for that session.
2. **Terminal sessions keep the keyboard.** A plain shell is typed at directly, exactly as on iPad.
3. **Touch scrolling reaches tmux.** A finger can finally drive tmux's wheel scrolling (copy-mode
   and Claude Code's own scroll region), on iPhone *and* iPad, without touching the
   trackpad/mouse path that already works.

---

## 1. What carries over untouched

Most of the app, which is the point of having built it in layers:

| Layer | Status on iPhone |
|---|---|
| `ClaveProtocol` (wire types, keymap) | Unchanged. No new messages, no capability negotiation. |
| `ClaveKit` (SSH, control plane, keychain, host keys) | Unchanged. |
| `ClaveTerminal` (mirror sizing, resync, chords, pointer layer) | Unchanged core; gains the touch-wheel path (§5), which iPad also wants. |
| Chat mode (`ChatPane`, `ChatSessionModel`) | Already the best phone surface in the app. Works on compact width as-is. |
| Compose sheet | Already phone-shaped (a `NavigationStack` in a sheet; sheets are full-screen on compact automatically). Becomes the *primary* text path on iPhone. |
| Transcript sheet | Works as-is; it is the copy/search/scrollback answer on the phone too. |
| Host editor, trust sheet, pairing, new-session sheet | Work as-is on compact. |
| App shortcuts (`UIKeyCommand`s) | Unchanged; they simply matter less without a Magic Keyboard. |

What does *not* carry over: the three-column `NavigationSplitView` shell (§3), the
tap-raises-keyboard input policy on agent sessions (§4), the accessory bar's two-row height budget
(§4.3), and the assumption that a wheel exists (§5).

---

## 2. Project mechanics

Small, mechanical, and first, because nothing can be verified on an iPhone simulator until the app
installs on one.

- `TARGETED_DEVICE_FAMILY = 2` becomes `"1,2"` in both app-target configurations of
  `Clave.xcodeproj`. The SPM modules already build for any iOS device.
- `Info.plist` gains a phone orientation key (`UISupportedInterfaceOrientations`): portrait plus
  both landscapes. Landscape matters more than usual here — it is the difference between ~55 and
  ~120 columns in takeover (§4.1) — so the terminal screen must not lock itself to portrait.
- `build-sim.sh --device "iPhone 17 Pro"` should work today (the flag passes through to
  `simctl`); verify and document it. `run-on-ipad.sh` needs nothing but a note that it also runs
  on a phone; renaming it (`run-on-device.sh`) is optional polish.
- The `--demo-screen` harness runs on an iPhone simulator unchanged, which is how each reshaped
  screen gets reviewed without a Mac on the other end — the same workflow the iPad screens used.
- Sweep the "iPadOS only" language: file-header comments, the README, and the handful of UI
  strings that say "this iPad" (§6).

---

## 3. Navigation: three columns become a stack

### 3.1 The shape

`RootView` keeps `NavigationSplitView`. On compact width it collapses to a navigation stack on its
own: Hosts → Sessions (or Activity) → Terminal, pushed in order. That is exactly the right phone
information architecture — `HostsColumn` is already "Activity + Macs" in one list, so the root
screen of the phone app already exists. No tab bar, no new screens.

What has to be verified rather than assumed: the app drives the split view through *selection*
(`model.selection`, `selectedSessionByHost`) rather than `NavigationLink`s, and collapsed split
views have a history of popping to root when observable state changes mid-push. The fallback, if
that bites, is an explicit `NavigationStack` used when `horizontalSizeClass == .compact`, pushing
the same three screens off the same selection state. Either way the three column views are reused
as screens; nothing is rewritten.

This work also pays on iPad: Slide Over and narrow Stage Manager windows put the iPad app in
compact width today, where the current shell has never been exercised.

### 3.2 The terminal screen on a phone

`TerminalPane` currently mounts a principal title plus four trailing toolbar items (Full Screen,
Compose, view-mode menu, Transcript). A phone navigation bar fits two, and the back button takes
one slot. Reshape on compact:

- **Compose stays a visible button** — it is the primary input, per decision 1.
- Full Screen, Transcript, and the view-mode picker fold into one ellipsis menu.
- The header row (glyph, name, cwd, geometry pill) is redundant with the navigation title on a
  pushed screen; on compact it collapses to a single thin strip, or drops entirely with the
  geometry pill moving into the ellipsis menu. Every point saved is a terminal row.
- The waiting banner and attach banners stay; they are the reason the phone came out of the
  pocket.
- `FullScreenTerminal` is promoted from convenience to the *expected* way to read a session on a
  phone. Same cover, same re-parenting handle; it already hides the status bar and home indicator.

### 3.3 Default view mode on iPhone

On iPad, Mirror is the default (§4 of the iPad plan). On a phone, mirroring a Mac-sized window
means a 200-column grid at the 11pt readable floor: a surface four screens wide that is panned,
never read. The right phone default for a terminal view is **Takeover**, which is precisely the
"tmux resizing" expectation: the session reflows to the phone's grid and is simply readable.

Rough numbers (Menlo 12pt, `fitPanePointSize`): portrait ≈ 52–56 columns × ~30 rows under the
compact chrome; landscape ≈ 110–120 columns. Claude Code's TUI renders fine at both; portrait is
tight but honest, and one rotation fixes it.

So: on iPhone, a session whose view has not been chosen defaults to `takeover` (today the
fallback in `HostRuntime.viewMode(for:)` is `.mirror`; make the fallback idiom-dependent). Chat
presets are unchanged — a Claude session created from the device is still preset to Chat, and
Chat is still offered whenever the host speaks it. Mirror and Watch remain one menu tap away, and
the menu's one-line explanations already tell the user what Takeover does to the Mac's window.

The cost to name in the menu copy and accept: takeover from a phone resizes the Mac's window to
phone proportions. That is what the mode means, it is per-session, and Mirror remains for the
user who is sitting in front of the Mac at the time.

---

## 4. Input: compose-first for agents, keyboard for terminals

### 4.1 The policy

| Session kind | iPhone default | Opt-out |
|---|---|---|
| Agent sessions (`claude`, `claudeAgents`, `codex`, `antigravity`) viewed as a terminal | **Compose-first**: tap focuses but raises no software keyboard; text goes through Compose; keys go through the accessory bar | A `keyboard` key on the accessory bar turns the raw keyboard on for that session |
| `terminal` sessions | Direct keyboard, as on iPad | n/a |
| Chat view | Its own composer, unchanged | n/a |
| iPad (all kinds) | Unchanged: direct keyboard everywhere | n/a |

The reasoning, stated once in code comments and here: an agent TUI redraws its whole frame
constantly, and on a phone the software keyboard covers half the surface. Every keyboard
appear/disappear is a safe-area animation racing a full-frame repaint over SSH, and — worse, in
takeover — a grid change and a tmux reflow *per keyboard transition*. Compose-first removes the
whole class: the keyboard lives inside a sheet, the terminal surface never changes size, and a
multi-line prompt arrives as one bracketed paste (the Compose sheet's existing contract). The
per-keystroke SSH round trip the iPad plan documents honestly (§4.4 "typing feels like typing
over SSH") also disappears for prose, which matters more on cellular, which is the phone's
natural habitat.

### 4.2 Mechanism

All in the existing seams; no SwiftTerm fork, consistent with the P0-C rule.

- `ClaveTerminalView` gains a `suppressesSoftwareKeyboard` flag and overrides
  `UIResponder.inputView`: when suppressed, return a shared zero-height `UIView` instead of `nil`.
  The view still becomes first responder on tap — selection, the edit menu, hardware keys, and
  `pressesBegan` chord interception all keep working — but no keyboard rises. Toggling calls
  `reloadInputViews()`, the same trick `setKeyboardAccessory` already uses.
- The flag is set by the app layer from idiom + session mode + the per-session override, through
  `TerminalInputTarget` (one new member beside `setKeyboardAccessory`), so `Input/` stays
  emulator-blind.
- The accessory bar gains the `keyboard` keycap (iPhone, agent sessions only): tap to raise the
  raw keyboard (`suppressesSoftwareKeyboard = false` + `becomeFirstResponder`), tap again to put
  it away. Sticky per session for the life of the attach, like the view-mode choice.
- Hardware keyboards need no detection dance: with a keyboard attached, keys arrive through
  `pressesBegan` regardless of the suppression flag, and iOS does not raise the software keyboard
  anyway. The `GCKeyboard` liveness caveat from the iPad plan stays irrelevant here — the flag is
  user-facing policy, never inferred from hardware state.

### 4.3 The accessory bar on compact

The bar is 124pt tall (status line + two 40pt rows). On a 390 × 844 screen next to a navigation
bar and the home indicator, that is too much standing chrome. On compact:

- One 40pt row, horizontally scrollable (the rows already scroll), merging the terminal row and
  the agent row in priority order: `esc` `ctrl` `tab` arrows `⇧tab` `^C` sigils punctuation, with
  **Compose pinned at the trailing edge** and the new `keyboard` key beside it.
- The status line ("ctrl armed", etc.) becomes a floating capsule overlaid *above* the bar only
  while a modifier is armed, so the bar's height never changes — preserving the iPad bar's
  design rule that arming a modifier must not move keys under the user's thumb.
- The bar stays a safe-area inset, never an `inputAccessoryView`, for the same measured reasons
  as on iPad (it must survive keyboard dismissal, and it must exist in compose-first mode where
  there is no keyboard at all).
- Terminal sessions with the keyboard raised keep the same single row; in takeover the grid
  reflow on keyboard show/hide is accepted and already debounced (120ms in
  `takeoverGridChanged`). Mirror-mode terminals reflow nothing; only the viewport shrinks.

---

## 5. Touch scrolling into tmux (iPhone and iPad)

### 5.1 The gap, precisely

Clave's tmux sets `mouse on`, so every attached client sits in mouse-tracking mode
(`mouseMode != .off`) whenever the desktop does. In that state `syncToMouseMode()` turns
`isScrollEnabled` off and enables the wheel gesture — which accepts
`allowedTouchTypes = [.indirectPointer]` only. Net effect today, on both idioms: **a trackpad
scroll becomes button 4/5 and drives tmux copy-mode / Claude Code's scroller beautifully; a
finger has no path at all.** Two-finger touch scrolling (the §6.2 gesture) only ever scrolled the
*local* SwiftTerm scrollback, which mouse-tracking mode disables and which is empty in the
alternate screen anyway. On iPad this is the "I can't drag to scroll" complaint; on iPhone there
is no trackpad, so without this section there is no scrolling at all.

That also defines the non-regression fence: the working trackpad/mouse path is gated on
`.indirectPointer` touches, so a new gesture that accepts **direct touches only** cannot collide
with it by construction. And when tracking is off, nothing below activates and the scroll view
behaves exactly as it does today.

### 5.2 Design: a touch wheel

One new gesture on `ClaveTerminalView`, owned by `TerminalPointerController` like everything else:

- A `UIPanGestureRecognizer`, `allowedTouchTypes = [.direct]`, **two fingers** (min and max),
  enabled only while `MousePolicy.reportsWheel(mouseMode)` and tracking is on — i.e. only in the
  state where the surface it claims is dead today. `syncToMouseMode()` gains one line to flip it
  alongside the others.
- Its handler is a twin of `handleWheel`: per-frame deltas into the **same `WheelCoalescer`**
  (one notch per cell height, ≤60/s, ±3-notch residual, reset on reversal), out through the same
  `send(wheel:at:modifiers:)`, so touch and trackpad produce byte-identical reports and the
  existing coalescer tests cover the arithmetic. A separate coalescer *instance* keeps a trackpad
  and a stray touch from sharing a residual.
- **No fling.** The coalescer discards momentum by design and a `UIPanGestureRecognizer` ends at
  finger-lift, so nothing needs synthesizing — and the iPad plan's flood warning (§6.1) says why
  deceleration must not be faked into wheel reports. Scrolling tracks the finger 1:1: a page of
  travel is a page of scroll. If that feels short on a phone, the tuning knob is notches per
  cell-height for direct touches, never synthetic momentum.
- Two-finger is chosen because it is the app's existing "scroll the content" gesture (§6.2), it
  leaves one-finger drags to the pan/selection layer untouched, and it cannot be confused with
  the mirror-viewport pan. It works fine one-handed-plus-thumb on a phone in landscape and is
  standard enough in portrait.

### 5.3 One-finger promotion where nothing else wants the finger

On iPhone in takeover (the default, §3.3), the mirror exactly fills the viewport, so the
one-finger viewport pan (`TerminalPanScrollView`) has nothing to move — the finger's most natural
scroll gesture is currently wasted. Promotion rule: when tracking is on **and** the mounted
terminal's frame fits the pan window (no overflow on either axis) **and** no local selection is
active, a one-finger vertical drag also feeds the touch wheel. Implemented as a second, one-finger
direct pan whose `gestureRecognizerShouldBegin` checks those three conditions, so:

- an oversized mirror keeps one-finger = pan-the-viewport, two-finger = scroll-the-content
  (unchanged mental model from iPad);
- a fitted takeover session scrolls like a native phone app;
- long-press-then-drag selection keeps priority (the selection guard the pan scroll view already
  applies).

### 5.4 A scrolled indicator

The §6.2 backlog item ("a live/scrolled indicator with a scroll-to-bottom button") earns its slot
in this phase, scoped honestly: for *local* scrollback (tracking off), a floating chip appears
when `buffer.yDisp` is above the bottom and taps back to live. For tmux copy-mode the host owns
the state; tmux already shows its own position indicator and exits copy-mode at the bottom, so the
client adds nothing there. An `esc` on the accessory bar (already present) is the copy-mode
escape hatch.

### 5.5 Referees, stated

- **Pinch vs two-finger pan:** both are two-finger direct gestures. The pinch (font zoom) already
  recognizes simultaneously with everything; a symmetric pinch has near-zero centroid translation
  so the coalescer emits little to nothing, but the touch-wheel handler still adds a small
  begin-threshold (half a cell of travel) so a zoom gesture cannot leak a stray notch into an
  agent TUI.
- **SwiftTerm's own pans:** unchanged; the foreign-pan referee (`adopt(foreignGesture:)`) already
  refuses them without an active selection.
- **Watch mode:** the byte sink is already a no-op there, so the touch wheel mutes itself for
  free — same path as every other input.

---

## 6. Copy and naming

The UI says "iPad" in ~six places (`PairingPanel`, `RevokedPanel`, `NotConnectedPanel`, the
view-mode menu details, the full-screen tip in the README, the `CLAVE-PUBKEY` console line's
comment). Introduce one device-word helper off `UIDevice.current.userInterfaceIdiom` ("this
iPhone" / "this iPad") and sweep. House rules apply to every new or touched string: no em-dashes
in UI copy, no "X, not Y" constructions — the view-mode detail strings already model the right
voice ("Resizes the Mac's window to fit this iPad" becomes "Resizes the Mac's window to fit this
iPhone" via the helper).

The pairing flow needs one look on a phone: the device name the Mac shows comes from
`UIDevice.current.name`, which on modern iOS is generic ("iPhone") for third-party apps. The
Devices list on the Mac may show two rows named "iPhone" and "iPad"; acceptable for v1, worth a
note in the approval UI copy if it confuses.

---

## 7. Verification

- **Unit (host-runnable, `swift test`):** the touch-wheel path gets the `WheelCoalescer`
  treatment — a `processTouchScroll(deltas:phase:)` seam on `TerminalPointerController` driven
  headlessly, asserting notch streams, the begin-threshold, the tracking-mode gate, and the
  one-finger promotion predicate. The compose/keyboard policy matrix (§4.1) is a pure function of
  (idiom, session mode, override) and gets a table test.
- **Simulator:** every reshaped screen via `--demo-screen` on an iPhone simulator, portrait and
  landscape; the collapsed navigation flow end to end; compose-first proven with
  `--log-input-bytes` (the byte log is already the proof tool for exactly this).
- **Hardware, the honest list** (the iPad plan's "not claimed until run on hardware" discipline):
  two-finger touch wheel feel and rate against real tmux copy-mode and Claude Code's scroller,
  over cellular as well as Wi-Fi; keyboard suppression with a paired Bluetooth keyboard; the
  pinch-vs-pan referee under real fingers; takeover reflow cadence when rotating the phone.
- **Regression pass on iPad:** trackpad wheel, hover, right-click, pinch, selection drag — all
  unchanged by construction (direct-touch gating), verified by the on-device harness that already
  exists for the pointer layer.

---

## 8. Phasing

Each phase lands independently and leaves the iPad app no worse.

| Phase | Contents | Proof |
|---|---|---|
| **IP0 — it installs** | Device family, orientations, build-script notes, file-header sweep | App runs on an iPhone simulator; iPad build byte-identical in behavior |
| **IP1 — it navigates** | Collapsed split view (or compact stack fallback), terminal-screen chrome reshape, takeover default on iPhone, full-screen polish | Demo screens on iPhone sim; select → attach → type-in-Compose round trip against a real Mac |
| **IP2 — touch scrolling** | §5 in full: two-finger wheel, one-finger promotion, scrolled chip, referees, tests. **Ships to iPad in the same release** — it fixes the standing iPad gap and is the riskiest piece, so it goes early and alone | Coalescer-level tests; hardware feel pass on both idioms |
| **IP3 — compose-first input** | Keyboard suppression, per-session keyboard opt-in, compact accessory bar | Byte-log proof; hardware keyboard pass |
| **IP4 — polish** | Copy sweep, pairing-name note, README, any UAT fallout | UAT round on a real phone, same format as §8e |

IP2 before IP3 on purpose: scrolling is shared surface with iPad and touches the pointer layer's
invariants, so it wants the longest soak; compose-first is additive app-layer policy.

---

## 9. Risks, named

| Risk | Severity | Handling |
|---|---|---|
| Collapsed `NavigationSplitView` pops to root on selection-driven state changes | Medium | Known SwiftUI failure mode; time-boxed spike in IP1, explicit compact `NavigationStack` as the ready fallback |
| Touch wheel leaks notches during a pinch | Medium | Begin-threshold plus centroid arithmetic (§5.5); harness-driven test with synthetic simultaneous gestures |
| A 52-column takeover grid renders an agent TUI badly in portrait | Medium | Landscape is one rotation away; Chat mode is the phone-native reading surface; Mirror remains in the menu. Nothing to build, just honest copy in the mode menu |
| Takeover from a phone resizes the Mac's window while someone is at the Mac | Low | Inherent to the mode and per-session; the mode menu says so; Mirror/Watch unaffected |
| `inputView` suppression fights SwiftTerm's `UITextInput` internals (dictation, marked text) | Medium | Spike early in IP3 on hardware; fallback is refusing first responder on tap for compose-first sessions and accepting that selection needs the long-press path (which it already uses) |
| One-finger promotion misfires on a mirror that almost fits | Low | Predicate is exact (frame ≤ viewport on both axes); when wrong, the cost is a pan instead of a scroll, never bytes to the host |
| Keyboard show/hide reflow thrash in takeover terminals | Low | Already debounced; if real-world cadence is worse, lengthen the debounce for keyboard transitions only |

---

## 10. House rules that apply

- No em-dashes in UI copy, and no "X, not Y" phrasing (`~/.claude/CLAUDE.md`).
- Any wire change discovered along the way follows the mirror rule (`remote-protocol.ts` ↔
  `RemoteProtocol.swift` ↔ `wire-messages.jsonl`) — none is expected in this plan.
- The `swift build`/`swift test`-on-macOS guard (`#if canImport(UIKit)`) stays intact in every
  touched file.
- Commits land in `clave-ios`; this document is the only change in the `clave` repo.

---

## 11. Project rules

- Perhaps most importantly: these iPhone accomodations can cause zero regressions in the iPad client; the iPad client is working great right now, and we want to keep it that way.