# Packaging and releasing

Three ways to produce a Clave.app, for three different situations.

| Command | Signing | Notarized | Use it for |
|---|---|---|---|
| `npm run build:mac:local -- --install` | Apple Development, from the keychain | no | daily driver on this Mac. TCC grants survive rebuilds because the certificate gives a stable designated requirement |
| `npm run package:mac` | Developer ID Application | yes | a real bundle: dmg + zip, installable anywhere, no version bump and no release |
| `npm run release -- --patch` | Developer ID Application | yes | bump, tag, build, and publish a GitHub Release the app can update itself from |

`npm run build:mac:test` still exists for an ad-hoc-signed dmg, which is only useful for checking the
installer flow itself.

## One-time setup

1. **A Developer ID Application certificate.** Xcode → Settings → Accounts → your Apple ID → Manage
   Certificates → + → Developer ID Application. Nothing is exported: electron-builder finds the
   identity in the login keychain. An Apple Development certificate cannot be notarized, which is
   the difference between this and `build:mac:local`.
2. **An app-specific password** from appleid.apple.com → Sign-In and Security → App-Specific
   Passwords. notarytool rejects the regular Apple ID password.
3. **`.env`**, from the template: `cp .env.example .env`, then fill `APPLE_ID` and
   `APPLE_APP_SPECIFIC_PASSWORD`. `APPLE_TEAM_ID` is already there. The file is gitignored and
   excluded from the packaged app.
4. **`gh`**: `brew install gh && gh auth login`. `release.sh` uses it to create the release and
   attach the artifacts.

`scripts/lib/signing-preflight.sh` checks all of this before anything is built, bumped, or pushed,
and names whatever is missing. An App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`) is accepted in place of the Apple ID trio if you already keep one for TestFlight.

## Cutting a release

```sh
git checkout prod
git merge --ff-only feat/your-branch
npm run release -- --patch      # or --minor, --major, --version X.Y.Z
```

`release.sh` bumps `package.json`, rolls `CHANGELOG.md`'s `[Unreleased]` section into the new
version, stamps `"next"` entries in `whats-new.json`, commits, builds the universal dmg and zip,
notarizes, tags, pushes, and creates the GitHub Release with the changelog section as its notes.

`CLAVE_RELEASE_BRANCH` overrides the branch it insists on, which defaults to `prod`.

The release carries five assets, and the updater needs three of them: `latest-mac.yml` is the feed,
the zip is what a background update downloads, and the dmg is what a human installs. The blockmaps
make updates differential.

## How the app finds updates

`publish` in `electron-builder.yml` points at `heisler98/clave`, so a build made here checks this
fork's releases and never upstream's. The repo is public, so no token is involved at check time.
`src/main/auto-updater.ts` checks five seconds after launch and every thirty minutes after that, and
downloads only once the user agrees.

CI releases are gated to the upstream repository. `.github/workflows/release.yml` carries
`if: github.repository == 'codika-io/clave'`, because a fork has neither the signing secrets nor the
release deploy key, and a push to its `prod` would otherwise burn a macOS runner to fail at the
first codesign call.

## This fork keeps `com.clave.app`

Developer ID distribution does not require a registered App ID: the notary service does not enforce
bundle-id uniqueness, and none of Clave's entitlements (JIT, unsigned executable memory, dyld
environment variables, audio input) need a provisioning profile. So the fork keeps the upstream
identifier and its builds replace `/Applications/Clave.app` in place, inheriting
`~/Library/Application Support/Clave` with every session, group, and preference intact.

Two things change on the first install after switching, both once:

- **Permissions are re-asked.** TCC keys its grants to the code signature, and the signing team is
  different now. If a grant seems stuck rather than re-prompted, `tccutil reset Microphone
  com.clave.app` clears it.
- **The safeStorage keychain entry may prompt.** `location-manager.ts` encrypts remote-host
  passwords and OpenClaw tokens through `safeStorage`, whose keychain item is bound to the old
  signature. Expect one macOS prompt to allow access. If it cannot be decrypted, those credentials
  come back empty and get re-entered per location; nothing else in the data directory is affected.

Reinstalling an upstream build later overwrites this one, because they share the identifier.

## The iPad client

`clave-ios` builds and ships separately: `./build-ipa.sh` produces a signed `.ipa` for Transporter,
and TestFlight distribution is documented in that repo's README.
