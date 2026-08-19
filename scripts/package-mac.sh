#!/usr/bin/env bash
#
# Build a signed, notarized Clave.app plus its dmg and zip, and stop there.
#
# This is the "give me a real bundle" path: no version bump, no tag, no
# GitHub release. `npm run release` is the path that publishes; it reuses the
# same signing preflight so a credential problem surfaces the same way in both.
#
# Env:
#   CLAVE_PACKAGE_ARCH    universal (default) or arm64
#
# Flags:
#   --arm64          arm64 only, which is roughly half the build time
#   --universal      explicit universal (the default)
#   --no-notarize    sign but skip notarization; Gatekeeper will still block
#                    this build on another Mac, so it is for local checks only
#   --open           reveal the finished bundle in Finder
#   --verify-only    re-run the checks against the last build, building nothing

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/lib/signing-preflight.sh
source scripts/lib/signing-preflight.sh

ARCH="${CLAVE_PACKAGE_ARCH:-universal}"
NOTARIZE=1
REVEAL=0
VERIFY_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arm64)       ARCH="arm64"; shift ;;
    --universal)   ARCH="universal"; shift ;;
    --no-notarize) NOTARIZE=0; shift ;;
    --open)        REVEAL=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help)     awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ "$ARCH" == "universal" || "$ARCH" == "arm64" ]] || fail "arch must be universal or arm64, got '$ARCH'"

VERSION="$(node -p "require('./package.json').version")"
APP_PATH="dist/mac-${ARCH}/Clave.app"

if [[ $VERIFY_ONLY -eq 1 ]]; then
  bold "Verifying the existing ${ARCH} build of Clave ${VERSION}"
  [[ -d "$APP_PATH" ]] || fail "$APP_PATH does not exist. Run without --verify-only first."
else
  # ── Preflight ─────────────────────────────────────────────────────────────
  [[ "$NOTARIZE" -eq 1 ]] || export CLAVE_SKIP_NOTARIZE=1
  clave_preflight_signing || fail "Signing preflight failed. Nothing was built."

  bold "Packaging Clave ${VERSION} (${ARCH}, notarize=$([[ $NOTARIZE -eq 1 ]] && echo yes || echo no))"

  # ── Build ─────────────────────────────────────────────────────────────────
  npm run build

  BUILDER_ARGS=(--mac "--${ARCH}" --publish never)
  [[ "$NOTARIZE" -eq 1 ]] || BUILDER_ARGS+=(-c.mac.notarize=false)

  npx electron-builder "${BUILDER_ARGS[@]}"

  [[ -d "$APP_PATH" ]] || fail "electron-builder reported success but $APP_PATH is missing"
fi

# ── Verify ──────────────────────────────────────────────────────────────────
# Each check answers a different question, and each one has bitten a Clave
# build before: is the bundle internally consistent, would Gatekeeper let it
# launch, and did the notarization ticket actually get stapled.
echo
bold "Verifying $APP_PATH"

codesign --verify --strict "$APP_PATH" 2>&1 | sed 's/^/  /'
echo "  signature: valid, satisfies its designated requirement"

# Read once into a variable and parse from a here-string. Piping into an awk
# that exits early makes codesign die of SIGPIPE, and under `set -o pipefail`
# that failure propagates into the assignment and ends the script — which is
# exactly what silently truncated this report on its first real run.
SIGN_INFO="$(codesign -dvv "$APP_PATH" 2>&1 || true)"
AUTHORITY="$(awk -F'=' '/^Authority=/ {print $2; exit}' <<< "$SIGN_INFO")"
echo "  authority: ${AUTHORITY:-unknown}"
echo "  architectures: $(lipo -archs "$APP_PATH/Contents/MacOS/Clave" 2>/dev/null || echo unknown)"

# The microphone entitlement is what lets voice input prompt at all. Same check
# build-mac-local.sh makes, for the same reason: it fails silently at runtime.
ENTITLEMENTS="$(codesign -d --entitlements - --xml "$APP_PATH" 2>/dev/null | plutil -p - 2>/dev/null || true)"
if grep -q 'com.apple.security.device.audio-input' <<< "$ENTITLEMENTS"; then
  echo "  microphone entitlement: present"
else
  fail "com.apple.security.device.audio-input is missing from the signed app."
fi

if [[ "$NOTARIZE" -eq 1 ]]; then
  if xcrun stapler validate "$APP_PATH" >/dev/null 2>&1; then
    echo "  notarization ticket: stapled"
  else
    fail "No stapled notarization ticket. The build is signed but Gatekeeper will reject it on another Mac."
  fi

  GATEKEEPER="$(spctl -a -vvv -t install "$APP_PATH" 2>&1 || true)"
  if grep -q "accepted" <<< "$GATEKEEPER"; then
    echo "  gatekeeper: accepted ($(awk -F'=' '/^source=/ {print $2; exit}' <<< "$GATEKEEPER"))"
  else
    fail "spctl rejected the bundle. Run: spctl -a -vvv -t install \"$APP_PATH\""
  fi
fi

# ── Report ──────────────────────────────────────────────────────────────────
echo
bold "Artifacts"
for f in "$APP_PATH" \
         "dist/clave-${VERSION}.dmg" \
         "dist/Clave-${VERSION}-${ARCH}-mac.zip"; do
  [[ -e "$f" ]] && printf '  %-46s %s\n' "$f" "$(du -sh "$f" | cut -f1)"
done

echo
echo "  Install it over the current one:"
echo "    open dist/clave-${VERSION}.dmg"
echo
echo "  This bundle keeps the com.clave.app identifier, so it replaces an"
echo "  existing /Applications/Clave.app and inherits its data directory."
echo "  macOS re-asks for permissions once, because the signing team changed."

[[ "$REVEAL" -eq 1 ]] && open -R "$APP_PATH"
exit 0
