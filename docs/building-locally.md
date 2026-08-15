# Building this fork as a first-class app on your own Mac

Target: a signed Clave build you run daily on Apple Silicon, with Claude Code voice input
working, that does not fight with the installed upstream Clave.

Everything below was verified on this machine (macOS 26.5, M-series, Claude Code 2.1.233).

---

## The bundle ID question, answered

**Yes, you can codesign an app whose bundle ID is already used by someone else. It does not
error.**

Code signing performs no global uniqueness check. `codesign` reads `CFBundleIdentifier` out of
your `Info.plist`, embeds it in the signature, and signs. There is no registry lookup and no
network call.

Verified directly: a throwaway `.app` declaring `CFBundleIdentifier = com.clave.app`, signed with
`Apple Development: Hunter Eisler`, hardened runtime on, carrying the microphone entitlement:

```
$ codesign --force --options runtime --entitlements ent.plist \
    --sign "Apple Development: Hunter Eisler (VUHR497JM5)" Dupe.app
Dupe.app: replacing existing signature          # exit 0

$ codesign --verify --strict Dupe.app
Dupe.app: valid on disk
Dupe.app: satisfies its Designated Requirement
```

The reason it is not a conflict is visible in the designated requirement:

```
designated => identifier "com.clave.app"
           and anchor apple generic
           and certificate leaf[subject.CN] = "Apple Development: Hunter Eisler (VUHR497JM5)"
           and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */
```

The identity is **bundle ID *plus* your certificate**. Codika's build carries the same identifier
but a different leaf certificate and team, so macOS treats the two as genuinely different code,
and the signature validates.

### What a duplicate bundle ID *would* break

Signing is fine. These are the real collisions:

| Concern | Affected? |
|---|---|
| `codesign` / `codesign --verify` | No |
| Notarization | No. It is a malware scan, not an identity registry |
| Running locally | No |
| **Registering an App ID in the developer portal** | **Yes.** App IDs are globally unique. You cannot register `com.clave.app` under your team |
| **TCC / System Settings privacy entries** | **Yes, in practice.** Two entries with the same bundle ID and different requirements gets confusing fast |
| **LaunchServices** | **Yes.** Two installed apps claiming one bundle ID makes "which app opens this" nondeterministic |
| **userData directory** | **Yes.** Both write `~/Library/Application Support/clave` |

You only need a registered App ID when an entitlement requires a provisioning profile (iCloud,
push, app groups, App Sandbox extras) or for the Mac App Store. **Clave needs none of those.** Its
entitlements are three `com.apple.security.cs.*` hardened-runtime flags plus
`com.apple.security.device.audio-input`, and the app is not sandboxed. No profile, no App ID
registration, no collision.

### Recommendation

Sign with `com.clave.app` if you are **replacing** upstream Clave. Change the identity if you want
both installed at once. To run side by side you must change all three, because they control
different things:

- `appId` in `electron-builder.yml` → TCC and LaunchServices identity
- `productName` in `electron-builder.yml` → `/Applications/<name>.app`
- `name` in `package.json` → `~/Library/Application Support/<name>` (this is the one that
  actually moves your sessions and preferences)

Changing `appId` alone will *not* separate your data.

---

## Route A: free, local, first-class (recommended)

You already have `Apple Development: Hunter Eisler (VUHR497JM5)` in your keychain. That is
sufficient. **The $99 Developer Program is not required for this.**

Notarization needs a *Developer ID* certificate, which does need the paid program, but
notarization only matters for apps carrying a quarantine attribute. Locally built apps never get
one, verified:

```
$ xattr -p com.apple.quarantine Dupe.app
xattr: No such xattr: com.apple.quarantine
```

So Gatekeeper never challenges an app you compiled on the machine you run it on.
(Your Mac also has `spctl --status: assessments disabled`, which makes this doubly moot, but the
no-quarantine reasoning is the durable one and holds even if you re-enable assessments.)

### Why not `scripts/build-mac-local-test.sh`

That script ad-hoc signs (`-c.mac.identity=null`, then `codesign --sign -`). Ad-hoc signatures
have no stable identity: TCC keys the grant to the binary's cdhash, which changes on every
rebuild, so **you would have to re-grant microphone access after every single build**. Fine for
smoke tests, useless for daily driving. A real certificate produces the team-and-bundle-ID
designated requirement shown above, which survives rebuilds.

### Build

```bash
cd ~/XcodeProjects/clave
npm run build:mac:local              # build and sign
npm run build:mac:local -- --install # ...and replace /Applications/Clave.app
```

`scripts/build-mac-local.sh` auto-detects a signing identity from your keychain, preferring
`Developer ID Application` and falling back to `Apple Development`. Override with
`CLAVE_SIGN_IDENTITY`, or build for Intel with `CLAVE_LOCAL_ARCH=x64`. It fails loudly if the
microphone entitlement is missing from the signed bundle, so a build that silently cannot record
never reaches `/Applications`.

The equivalent by hand:

```bash
npm run build          # native:build (Swift helper) + typecheck + electron-vite build

npx electron-builder --mac dir --arm64 \
  --publish never \
  -c.mac.notarize=false \
  -c.mac.hardenedRuntime=true \
  -c.mac.identity="Apple Development: Hunter Eisler (VUHR497JM5)"
```

Notes:

- `--arm64`, not the configured `universal`. You are on Apple Silicon; universal roughly doubles
  build time and drags in the x64 `node-pty` prebuild handling that `x64ArchFiles` exists to work
  around.
- `dir` produces `dist/mac-arm64/Clave.app` directly. Swap `dir` for `dmg` only if you want an
  installer artifact.
- Keep `hardenedRuntime=true`. It matches what your production builds do, so local behavior equals
  shipping behavior and the entitlements file applies identically.
- `npm run build` needs Xcode Command Line Tools for the Swift mission-control helper. Skip it and
  the app logs `mission-control-helper ENOENT` at launch.

### Verify before installing

```bash
codesign --verify --strict --deep --verbose=2 dist/mac-arm64/Clave.app
codesign -d --entitlements - --xml dist/mac-arm64/Clave.app | plutil -p -
codesign -d -r- dist/mac-arm64/Clave.app          # should name YOUR certificate
```

You want to see `com.apple.security.device.audio-input => 1` in the entitlements dump. If it is
missing, the microphone will never prompt.

### Install and clear the cached denial

macOS has already recorded a microphone denial against this bundle ID from before the entitlement
existed. Installing alone will not clear it.

```bash
rm -rf /Applications/Clave.app                    # only if replacing upstream
cp -R dist/mac-arm64/Clave.app /Applications/
tccutil reset Microphone com.clave.app
```

Then launch, open a Claude Code tab, run `/voice`, and macOS should present the permission
dialog for the first time.

---

## Route B: paid Developer Program

Enrolling ($99/yr) gets you a **Developer ID Application** certificate, which unlocks
`notarize: true` and lets `npm run build:mac` run exactly as configured.

Worth it if you want to move the build between Macs, hand it to anyone else, or stop thinking
about quarantine entirely. For one machine it buys nothing over Route A. Requires
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` in `.env` alongside `CSC_LINK` /
`CSC_KEY_PASSWORD`.

---

## Repo-specific gotchas

### 1. The auto-updater feed (already handled)

`electron-builder.yml` originally pointed `publish` at `codika-io/clave`, so a packaged fork
checked **Codika's** releases. `autoDownload` is false (`src/main/auto-updater.ts:21`) so nothing
happened silently, but you would get update prompts, and one careless click would reinstall stock
Clave over your fork.

This fork now points at `heisler98/clave`:

```yaml
publish:
  provider: github
  owner: heisler98
  repo: clave
```

If you never cut releases there the check 404s and `auto-updater.ts` swallows the error, which is
the quiet outcome you want. Re-check this line after merging anything from upstream, since it is
the kind of value a merge will happily revert.

### 2. Shared data with the installed Clave

Covered above. `userData` comes from `name` in `package.json` (`clave`), so a fork built with the
defaults shares `~/Library/Application Support/clave` with upstream Clave: sessions, groups,
`clave-preferences.json`, tmux sidecars, all of it. Intentional if you are replacing it, a hazard
if you are not.

### 3. tmux and the microphone

The tmux server is a detached daemon (`pty-manager.ts`, socket `-L clave`,
`destroy-unattached off`). A server that outlived the Clave instance which spawned it may have a
broken responsible-process chain, and macOS attributes microphone requests to the responsible
process.

**If voice still fails after the entitlement is in place, test once with tmux mode off**
(Settings > Sessions > Persistent sessions). If it works without tmux and not with it, that is the
cause.

### 4. Push-to-talk key delivery

Hold-to-talk depends on key-repeat events reaching the CLI. If it turns out Claude Code detects
hold via the kitty keyboard protocol (real key-up events) rather than repeat rate, it will not
work through xterm.js regardless of permissions. `/voice tap` is the fallback.

---

## Rebuild workflow

After the first setup, iterating is one command:

```bash
npm run build:mac:local -- --install
```

Because the certificate is stable, **the microphone grant persists across rebuilds**. You only
need `tccutil reset` again if you change the bundle ID or the signing certificate.

Verified on this machine: the build completes, `codesign --verify --strict --deep` reports
`valid on disk` and `satisfies its Designated Requirement`, the signed bundle carries
`com.apple.security.device.audio-input`, hardened runtime is on (`flags=0x10000(runtime)`), and
the output has no quarantine attribute.
