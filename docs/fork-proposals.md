# Fork proposals

Six requested features, with root causes traced in this codebase and a concrete plan for each.
Every claim below has a file:line anchor or was verified empirically against the running system
(Claude Code `2.1.233`, Clave `1.64.1`).

Suggested build order is at the bottom.

---

## 1. Native notifications from Claude Code sessions

### What's actually there today

Clave already has most of the machinery. Three separate things are broken.

| Piece | Location | State |
|---|---|---|
| Native notification | `src/main/notification-manager.ts` | Electron `Notification`, IPC `notification:show`, click focuses the tab |
| Deterministic agent state | `src/main/agent-state-manager.ts` + `src/main/pty-manager.ts:28-73` | Works: CC lifecycle hooks injected per spawn via `--settings` |
| Notification trigger | `src/renderer/src/hooks/use-terminal.ts:11-23` | Fragile regex over stripped PTY text |

**Blocker 1 — the focus gate.** `notification-manager.ts:14-18`:

```ts
const win = BrowserWindow.fromWebContents(event.sender)
if (win?.isFocused()) {
  console.log('[notification] Skipped (window is focused):', options.body)
  return 'skipped-focused'
}
```

Window-level, not tab-level. If Clave is the frontmost app, nothing ever fires, even for a
background tab you cannot see. This is also why `clave_notify` never works: the MCP tool routes
through the exact same handler (`src/renderer/src/lib/mcp-dispatcher.ts:430`).

**Blocker 2 — the hook throws away the case you care about.** `pty-manager.ts:55-67` injects a
`Notification` hook whose entire body is:

```
grep -qiE "permission|elicitation" && mkdir -p <dir> && printf blocked > <state> || true
```

Claude Code's `Notification` hook fires for a set of notification types. Verified from the CC
binary, the full list is:

```
permission_prompt, idle_prompt, auth_success, elicitation_dialog, agent_needs_input,
agent_completed, elicitation_url_dialog, worker_permission_prompt, push_notification,
computer_use_enter, computer_use_exit
```

Clave keeps only `permission_prompt`/`elicitation_*` and discards `idle_prompt` and
`agent_needs_input` with `|| true`. Those are exactly the "Claude is waiting for your input"
events. And even the kept case only writes a state word for a sidebar dot; it never notifies.

**Blocker 3 — the OSC path CC uses in Ghostty/iTerm cannot reach Clave.** Verified from the
binary, CC's notification dispatcher is:

```js
function h_m(e,t,r){switch(e){
  case"iterm2": r.notifyITerm2(t); return;
  case"iterm2_with_bell": r.notifyITerm2(t), r.notifyBell(); return;
  case"kitty": r.notifyKitty({...t,title:t.title||m_m,id:G8v()}); return;
  case"ghostty": r.notifyGhostty({...t,title:t.title||m_m}); return;
  case"terminal_bell": r.notifyBell(); return;
  case"disabled": case"none": case"no_method_available": return }}
```

Channel resolution is `auto` by default and keys off terminal identity. Clave's spawn env
(`pty-manager.ts:707-717`) sets only `TERM=xterm-256color` and `COLORTERM=truecolor`, and never
sets `TERM_PROGRAM`, so `auto` lands on `no_method_available`. Three further layers would block it
anyway: Clave's generated tmux config (`pty-manager.ts:197-234`) does not set
`allow-passthrough on`, so tmux would swallow the sequence; the main process forwards raw PTY
bytes without inspection (`src/main/ipc-handlers/pty-handlers.ts:37-40`); and nothing subscribes
to xterm's bell or OSC events.

### Plan

**Layer A — remove the gate (do this first, it is most of the value).**

Decided behavior: **always notify**. No suppression when the window is focused, and none when
the notification comes from the tab currently on screen. Every notification fires.

- Delete the `win?.isFocused()` early return in `notification-manager.ts:14-18`.
- Add a preference `notificationMode: 'always' | 'unfocused-window' | 'off'`, defaulting to
  `'always'`. The quieter mode stays available as an option, but nothing suppresses by default.
- `NotificationStatus` keeps `'unsupported'`; the `'skipped-focused'` value only ever appears
  when the user has explicitly chosen `'unfocused-window'`.

One change fixes `clave_notify`, the exit notification, and the prompt heuristic at once, because
all three go through this handler.

**Layer B — make the signal deterministic (the actual feature).**

Extend `buildClaudeHookSettingsArg()` (`pty-manager.ts:28-73`) so hooks emit the full payload
instead of a single word. Append the raw hook stdin as a JSON line to
`<userData>/agent-events/<claveSessionId>.jsonl` (`cat >> file` needs no `jq`). Add a watcher next
to `agent-state-manager.ts` that tails it and calls the notification path from main.

Map notification types to copy:

| Source | Notification |
|---|---|
| `permission_prompt`, `elicitation_dialog`, `worker_permission_prompt` | "Claude needs your permission" |
| `idle_prompt`, `agent_needs_input` | "Claude is waiting for your input" |
| `agent_completed`, `Stop` hook | "Turn complete" (off by default, it is noisy) |

Title the notification with the Clave tab name so several sessions are distinguishable. Click to
focus is already wired end to end (`notification-manager.ts:28-34` →
`src/renderer/src/components/layout/AppShell.tsx:449-454`).

Retire or demote the regex heuristic in `use-terminal.ts:11-23` once this lands. It matches on
rendered widget text ("Esc to cancel", "Allow"/"Deny") and will keep producing false positives.

**Layer C — OSC parsing (optional, and mainly for the other providers).**

For Codex and Antigravity there are no hooks, so a bell/OSC scanner is the only generic signal.
That needs all of: `set -g allow-passthrough on` in the tmux config, an OSC 9/777 scanner in the
main-process data path, and a `TERM_PROGRAM` value CC recognizes. I would not spoof
`TERM_PROGRAM=ghostty` for Claude sessions just to get notifications, since it also changes image
and keyboard-protocol behavior. Keep Layer B for Claude and use Layer C only as the non-Claude
fallback.

### Note on your existing setup

`~/.claude/settings.json` currently has `Notification` and `Stop` hooks that shell out to
`osascript`. Clave's `--settings` hooks merge with yours rather than replacing them, so once
Layer B lands you will get two notifications per event. Plan to remove yours, or have the Clave
setting mention it.

Those `osascript` hooks also read `~/.claude/projects/<dir>/sessions-index.json` for a title.
That file exists for only 1 of your 14 project directories and was last written in February, so
the hooks are almost always falling back to `basename $cwd`. Do not build anything on that file.

**Effort:** Layer A ~1h. Layer B ~5h. Layer C ~4h.

---

## 2. Session auto-titles

Two independent bugs, both small and both confirmed.

### Bug 2a — garbage titles like `<local-command-caveat>`

`title-generator.ts` tails the CC transcript JSONL and takes the first `"type":"user"` line that
passes `isValidMessage()` (`title-generator.ts:206-209`). That validator is the entire
sanitization pass (`title-generator.ts:359-364`):

```ts
function isValidMessage(msg: string): boolean {
  if (msg.length < 5) return false
  if (msg.startsWith('/')) return false
  if (/^(y|n|yes|no)$/i.test(msg)) return false
  return true
}
```

Modern Claude Code does not store `/usage` as the user turn. It writes a sequence of synthetic
user entries. From a real transcript on this machine:

```json
{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond...</local-command-caveat>"},"isMeta":true,...}
{"type":"user","message":{"role":"user","content":"<command-name>/usage</command-name>\n <command-message>usage</command-message>\n <command-args></command-args>"}}
```

The caveat is >5 chars and starts with `<`, not `/`, so the slash-command guard never fires. It
becomes `userMessage`, `titleDone` latches, and it goes straight into the Haiku prompt with no
stripping. When Haiku's answer is then rejected by the >6-word guard (`title-generator.ts:337`),
`heuristicTitle()` (`title-generator.ts:369-378`) takes the first four words lowercased and
returns literally `<local-command-caveat>caveat: the messages`. That is deterministic, and it is
what you have been seeing.

**Fix (~15 lines):**

- `parseUserMessage()` (`:249`): `if (entry.isMeta === true) return null`. This is CC's own marker
  for "not a real user turn" and kills the whole class.
- `isValidMessage()` (`:359`): also reject content containing `<local-command-caveat>`,
  `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`,
  `<local-command-stderr>`, `<system-reminder>`; and reject content that is only an
  `<attachment>` block.
- Strip any remaining `<tag>` wrappers before the length check, then re-validate.

**While you're in the file:** `runTitleGeneration()` (`:309-312`) calls
`execFile('claude', ['-p','--model','haiku'], ...)` with no `cwd`, so it inherits Electron's cwd
(usually `/`). Every title generation writes a throwaway transcript into
`~/.claude/projects/-/` — there are 13 of them on this machine right now. Pass
`cwd: entry.cwd`.

### Bug 2b — sessions in a group never auto-rename

Nothing checks group membership. `Session` has no `groupId` at all; groups hold
`sessionIds` (`src/renderer/src/store/session-types.ts:158`). The real guard is
`userRenamed` (`src/renderer/src/store/session-store.ts:906`):

```ts
autoRenameSession: (id, name) => {
  const session = ...
  if (!session || session.userRenamed) return
```

And the pinned/`.clave` group launch path sets that flag before the session has said a word
(`src/renderer/src/store/pinned-store.ts:604-606`):

```ts
if (session.name !== sessionInfo.folderName) {
  useSessionStore.getState().renameSession(sessionInfo.id, session.name)
}
```

`renameSession` is the "the human typed this" setter and always sets `userRenamed: true`
(`session-store.ts:899`). A `.clave` file's session `name` is a required field, and a pin captures
whatever label was showing when you pinned it, so this branch fires for essentially every group
session on every launch. The title generator still runs and still emits
`session:auto-title:<id>`; the store silently swallows it. It also persists: the flag is mirrored
into the tmux sidecar (`pty-manager.ts:797-805`) and restored on relaunch
(`AppShell.tsx:175-178`), so a locked session stays locked forever.

**Fix.** Replace the boolean with a source, which is the distinction the code actually needs:

```ts
nameSource: 'auto' | 'preset' | 'user'
```

- Typing a name in the sidebar → `'user'`.
- A `.clave` file or a pin or MCP `clave_open_session` supplying a name → `'preset'`.
- `autoRenameSession` bails only on `'user'`. A preset is a placeholder a real title may replace.

Keep `userRenamed` as a derived value for back-compat with persisted sidecars; `addSession`
already defaults it defensively (`session-store.ts:342`).

If you would rather some `.clave` names stay pinned, add an explicit `pinTitle: true` field
instead. That is more work and triggers the enum-sync rule in `CLAUDE.md` (schema in
`src/main/mcp/mcp-server.ts` plus the `clave-plugin` skill). My recommendation is `nameSource`:
a `.clave` session called "backend" is a slot label, not a title you chose for that conversation.

### Bug 2c — the title generates once and never updates

`titleDone` latches at `:211` and the watcher unregisters at `:170-173`. In Ghostty, CC keeps the
title current as the conversation moves. If you want that, re-trigger on a new user prompt after
N minutes. `/clear` already resets correctly (`:98-115`). Optional.

### The OSC alternative, and why I would not take it

CC does emit OSC 0/2 title sequences — verified, the binary contains `]0;` and `]2;` payload
strings. Wiring `terminal.onTitleChange` would be provider-agnostic and would sidestep the whole
JSONL pipeline. But Clave's tmux config never sets `set-titles on`, and tmux has defaulted both
`set-titles` and `allow-rename` to off since 2.1, so with tmux on (the default) the outer PTY
sees nothing. It would also mean giving up Clave's nicer summarized titles for whatever CC picks.
Fix the two bugs above instead; revisit OSC only if you later want Codex and Antigravity titled
too.

**Also worth knowing:** remote SSH sessions never auto-title at all, because they have no local
`claudeSessionId` and the scheduling check requires one (`pty-handlers.ts:29`). Separate feature
if you want it.

**Effort:** ~3h for 2a + 2b.

---

## 3. Usage in the toolbar

Easiest of the six. No new backend at all.

Existing pieces:

- `src/main/usage-manager.ts` reads the OAuth token from Keychain
  (`security find-generic-password -s "Claude Code-credentials" -w`) and GETs
  `https://api.anthropic.com/api/oauth/usage`. Returns
  `{windows: [{key,label,usedPercentage,resetsAt}], fetchedAt}` or `{error}`. Three windows:
  5-hour, weekly all-models, weekly Opus. No caching, no polling.
- IPC `usage:get-limits`, preload `getUsageLimits()` (`src/preload/index.ts:189`).
- `src/renderer/src/components/usage/UsagePanel.tsx` — `UsageBar`, `formatReset`, `barColor` and
  `ClaudeUsage` are already self-contained. Only the outer `UsagePanel` wrapper is settings-shaped.
- Toolbar is inline in `AppShell.tsx:601-658`. The exemplar for icon + popover is
  `src/renderer/src/components/layout/ToolbarSecretPopover.tsx`.

Plan:

1. Extract `UsageBar` / `formatReset` / `barColor` into `components/usage/usage-bits.tsx` so both
   surfaces share them. `CLAUDE.md` is explicit about not duplicating styling logic.
2. Add `store/usage-store.ts` with a single cached fetch, ~60s TTL, refresh while the popover is
   open. Today the settings page and a new popover would each hit Keychain and the network
   independently.
3. New `components/layout/ToolbarUsagePopover.tsx` modeled directly on `ToolbarSecretPopover.tsx`:
   `btn-icon btn-icon-sm` trigger with `ChartBarIcon` (matching the Settings nav icon at
   `SettingsSidebar.tsx:5-13`), tinted with `--color-status-waiting` at ≥70% and red at ≥90%
   (reuse `barColor`'s thresholds), `PopoverContent animated side="bottom" align="end"
   sideOffset={8}`. Body: three bars, "resets in 3h12m", a refresh button, and a link that calls
   `setSettingsSection('usage')`.
4. Mount at `AppShell.tsx:636`, beside `<ToolbarSecretPopover />`, inside the existing
   `WebkitAppRegion: 'no-drag'` cluster.
5. Add `.meter` / `.meter-fill` to `main.css`. The bar is currently hand-rolled Tailwind with no
   design-system class, which the design-system rule in `CLAUDE.md` says to fix rather than repeat.

**Effort:** ~3h.

---

## 4. Stop prompting for a folder every time

### Current shape

Every new-session path calls the picker unconditionally. `AppShell.tsx:67-113`:

```ts
const spawnSessionWithOptions = useCallback(async (claudeMode, dangerousMode, ...) => {
  const folderPath = await window.electronAPI.openFolderDialog()   // always
  if (!folderPath) return
```

That one function backs all six shortcuts (Cmd+T/N/D/I/U and Cmd+Shift+A,
`AppShell.tsx:328-353`). There are two more independent copies of the same flow:
`Sidebar.tsx:235` (`handleNewSession`, behind `NewSessionDropdown`) and
`src/renderer/src/components/session/NewSessionButton.tsx:11` (empty state).

Useful facts:

- `dialog:openFolder` already accepts `defaultPath` (`src/main/ipc-handlers/shell-handlers.ts:86-96`),
  so the "pick a different one" path needs no main-process change.
- There is no MRU or last-directory storage anywhere in the app.
- A generic preferences API already exists: `preferencesGet/Set`
  (`src/preload/index.ts:322-324` → `src/main/ipc-handlers/clave-file-handlers.ts:669-675`).
- **There is no Electron application menu.** `Menu` is never imported anywhere in `src/main`. So
  this has to be renderer UI.
- Precedent for reusing a known cwd with no picker: group terminals (`Sidebar.tsx:567`), duplicate
  (`:723`), resume (`:774`).

### Plan

1. **Factor the three flows into one** `lib/create-session.ts` exposing
   `createSession(options, { cwd })`. Prerequisite — implementing this three times is how they
   drift apart (they already differ: only the Sidebar copy threads `claudeProfileId`).
2. Persist `recentSessionDirs: string[]` (MRU, cap 8) and `newSessionDirMode: 'lastUsed' | 'alwaysAsk'`
   through `preferencesGet/Set`. Push on every successful spawn.
3. Default: Cmd+N and the dropdown's primary items spawn into `recentSessionDirs[0]` with no
   dialog. Empty list falls back to the picker.
4. Explicit "choose a folder" affordances:
   - `NewSessionDropdown.tsx` gets a **Recent** section (last 5 directories, basename plus dimmed
     parent) and a permanent **"Other folder..."** item that opens the picker with
     `defaultPath = recentSessionDirs[0]`.
   - Hold Option with Cmd+N (or Option-click) to always prompt.
   - Right-click the "New session" button for the same menu, using the existing
     `ui/ContextMenu.tsx` + `setContextMenu` pattern. Note `ui/context-menu.tsx` (the Radix one) is
     dead code — do not extend it.
5. Show the target directory as a subtitle on the primary item so "New session" is never a
   surprise.
6. Settings toggle in the Sessions section (`SettingsPanel.tsx:335-369`, next to the tmux
   toggle): "Start new sessions in the last used folder" / "Always ask".

**Effort:** ~4h including the refactor.

---

## 5. Voice mode / microphone

This is a packaging problem, not a code problem. It is also the one with real residual
uncertainty, so I want to be straight about that.

### Facts

- `build/entitlements.mac.plist` contains exactly three keys: `com.apple.security.cs.allow-jit`,
  `com.apple.security.cs.allow-unsigned-executable-memory`,
  `com.apple.security.cs.allow-dyld-environment-variables`. No audio-input entitlement. Not
  sandboxed.
- `electron-builder.yml` `mac.extendInfo` declares only `NSDocumentsFolderUsageDescription` and
  `NSDownloadsFolderUsageDescription`. **`NSMicrophoneUsageDescription` appears nowhere in the
  repo.**
- `mac.entitlementsInherit` is set; `mac.entitlements` is not.
- No `systemPreferences.askForMediaAccess` or `getMediaAccessStatus` call exists in `src/`.
- Claude Code records via a built-in native module inside its own process (per Anthropic's voice
  docs; the `arecord`/`rec` fallback is Linux-only). Your `~/.claude/settings.json` already has
  `"voiceEnabled": true`.

### Why nothing prompts

macOS attributes a capture request to the *responsible process* of the requester. For
`Clave.app → zsh -l -c → claude`, that is Clave.app. Clave.app's Info.plist has no microphone
usage string, so the system denies without ever showing a dialog. iTerm and Ghostty work because
they ship the usage string and you have already granted them access.

### Fix

1. `electron-builder.yml`, `mac.extendInfo`:
   `NSMicrophoneUsageDescription: "Clave needs microphone access so voice input works in your agent sessions."`
2. `build/entitlements.mac.plist`: add `com.apple.security.device.audio-input`. Not strictly
   required for a non-sandboxed hardened-runtime app, but it is what the hardened runtime expects
   for capture and it is harmless. Also set `mac.entitlements` explicitly to the same file so the
   main executable gets it and not only inherited children.
3. Optionally call `systemPreferences.askForMediaAccess('microphone')` from main behind a Settings
   button, so the prompt appears at a moment that makes sense, and use
   `getMediaAccessStatus('microphone')` to show the current state.
4. Rebuild signed and notarized, then `tccutil reset Microphone <bundle-id>` to clear the cached
   denial on your current install.

### Risks to test before believing it

- **tmux.** The tmux server is a detached daemon (`pty-manager.ts:609-625`, socket `-L clave`,
  `destroy-unattached off`). A process under a daemon that outlived the Clave instance that spawned
  it may have a broken responsible-process chain, so TCC could attribute to the wrong thing.
  **Test with tmux mode off first.** If voice works without tmux and not with it, that is the
  answer.
- **Dev builds.** `scripts/build-mac-local-test.sh` ad-hoc signs (`codesign --sign -`), which gives
  no stable TCC identity — every rebuild looks like a brand new app. Test against a properly
  signed build, not `npm run dev`.
- **Push-to-talk key delivery.** Hold mode depends on key-repeat events. A held spacebar through
  xterm.js and the PTY arrives as repeated `0x20`, which is probably fine, but if CC's hold
  detection uses the kitty keyboard protocol (real key-up events) it will not work through this
  stack regardless of mic permission. Test immediately after the entitlement fix; `/voice tap` is
  the fallback.

**Honest read:** steps 1 and 2 are near-certainly necessary. I would put them at roughly 70% to
also be sufficient, with tmux and key-repeat as the two things most likely to still bite.

**Effort:** ~2h of changes, plus a signed-build test cycle.

---

## 6. Cmd+Backspace and Cmd+arrows

Not a tmux problem. macOS Cmd modifiers are never encoded into terminal input by any terminal;
iTerm and Ghostty synthesize bytes for them in their own key handlers. Clave has to do the same.
One half of this is also an active bug.

### Cmd+Backspace currently destroys your session

`AppShell.tsx:365-377`, a global `window` keydown listener:

```ts
// Cmd+Delete: Close focused session
if (e.metaKey && e.key === 'Backspace') {
  e.preventDefault()
  const sid = useSessionStore.getState().focusedSessionId
  if (sid) {
    if (isFileTabId(sid)) { removeFileTab(sid) }
    else { window.electronAPI.killSession(sid).catch(() => {}); removeSession(sid) }
  }
}
```

The comment says Cmd+Delete but it is bound to Backspace, and it does not check whether focus is
in a terminal. So the keystroke you want to mean "delete to line start" currently means "kill this
session".

### Cmd+arrows do nothing

`attachCustomKeyEventHandler` in `src/renderer/src/hooks/use-terminal.ts:71-104` handles
Shift+Enter and four Option combos (`\x1b\x7f`, `\x1bd`, `\x1bb`, `\x1bf`) and has **no `metaKey`
branch at all**. xterm has no built-in Meta+Arrow mapping, so the keystroke is dropped before
tmux or the PTY ever see it.

### Fix

Add Cmd handling alongside the existing Option handling, in both `use-terminal.ts:71-104` and
`src/renderer/src/hooks/use-remote-terminal.ts:151-172`:

| Key | Bytes | Effect |
|---|---|---|
| Cmd+Left | `\x01` (Ctrl-A) | start of line |
| Cmd+Right | `\x05` (Ctrl-E) | end of line |
| Cmd+Backspace | `\x15` (Ctrl-U) | delete to start of line |
| Cmd+Delete (fn+Delete) | `\x0b` (Ctrl-K) | delete to end of line |
| Cmd+Up / Cmd+Down | (optional) scroll terminal to top / bottom |

This is the readline convention Claude Code's prompt already honors — you are using Ctrl-U
successfully today, which verifies at least that row. These are ordinary control bytes, so tmux
passes them straight through; Clave's config rebinds nothing relevant and the prefix stays C-b.

**And stop the global handler from stealing it.** Cleanest version: handle Cmd+Backspace in the
terminal key handler (which runs first and can `preventDefault()`), then add one guard at the top
of `AppShell.tsx`'s listener:

```ts
if (e.defaultPrevented) return
```

That fixes this whole class of conflict, not just this key. I would also move session-close off
Cmd+Backspace entirely — a destructive action one keystroke away from a text-editing reflex is
worth relocating. Cmd+Shift+Backspace is taken (`Sidebar.tsx:308`, reset all), so Cmd+Shift+W is
the natural home.

### While you're in the tmux config

`pty-manager.ts:197-234` should also pick up what Anthropic's terminal-config docs recommend:

```
set -g allow-passthrough on
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
```

`allow-passthrough` is what lets OSC notifications and progress reach the outer terminal (relevant
to Feature 1 Layer C). `extended-keys` is the general fix for Shift+Enter, which Clave currently
hand-rolls.

**Effort:** ~2h.

---

## Suggested order

| # | Work | Why here | Effort |
|---|---|---|---|
| 1 | Feature 6 | Smallest, and Cmd+Backspace is actively destructive today | 2h |
| 2 | Feature 1 Layer A | Near-one-line gate change, immediately fixes `clave_notify` | 1h |
| 3 | Feature 2 | Two small well-understood fixes with confirmed root causes | 3h |
| 4 | Feature 3 | Self-contained, no backend work | 3h |
| 5 | Feature 4 | Needs the create-session refactor first | 4h |
| 6 | Feature 1 Layer B | The real notification feature, builds on Layer A | 5h |
| 7 | Feature 5 | Small change, but gated on a signed-build test cycle | 2h + testing |

## House rules that apply

- No em-dashes in UI copy, and no "X, not Y" phrasing (`~/.claude/CLAUDE.md`).
- Verify renderer changes with the **Playwright Electron MCP**, not the plain Playwright MCP
  (`CLAUDE.md`).
- Features 2 and 4 touch `.clave` semantics. If any `.clave` field or enum changes, update all
  three mirrors in the same change: `session-types.ts`, `src/main/mcp/mcp-server.ts`, and the
  `clave-plugin` repo's `create-workspace` skill.
