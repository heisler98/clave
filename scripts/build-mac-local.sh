#!/usr/bin/env bash
#
# Build a signed local Clave for daily use on this Mac.
#
# Unlike build-mac-local-test.sh (which ad-hoc signs), this signs with a real
# certificate from your keychain. That matters: an ad-hoc signature ties the
# macOS TCC grant to the binary's cdhash, which changes on every build, so
# microphone access would have to be re-granted after every rebuild. A real
# certificate produces a designated requirement based on the bundle ID and the
# certificate, which survives rebuilds.
#
# Notarization is deliberately off. It only matters for apps carrying a
# quarantine attribute, and a locally built app never gets one.
#
# Env:
#   CLAVE_SIGN_IDENTITY   signing identity to use (default: auto-detected,
#                         preferring Developer ID Application)
#   CLAVE_LOCAL_ARCH      arm64 (default) or x64
#
# Flags:
#   --install             replace /Applications/Clave.app with the new build

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ARCH="${CLAVE_LOCAL_ARCH:-arm64}"
APP_PATH="dist/mac-${ARCH}/Clave.app"

# --- Resolve a signing identity -------------------------------------------
# Developer ID is preferred (it also permits notarization later), but an Apple
# Development certificate is enough for an app that only runs on this machine.
# `|| true` because "no certificate of this kind" is an expected outcome: grep
# exits non-zero, and under `set -e -o pipefail` that would abort the script
# before the fallback below ever runs.
find_identity() {
  security find-identity -v -p codesigning 2>/dev/null \
    | grep -oE "\"$1: [^\"]+\"" \
    | head -1 \
    | tr -d '"' || true
}

IDENTITY="${CLAVE_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(find_identity 'Developer ID Application')"
fi
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(find_identity 'Apple Development')"
fi
if [ -z "$IDENTITY" ]; then
  echo "error: no codesigning identity found in the keychain." >&2
  echo "       Run 'security find-identity -v -p codesigning' to check, or set" >&2
  echo "       CLAVE_SIGN_IDENTITY to the identity you want to use." >&2
  exit 1
fi

echo "== Signing identity =="
echo "$IDENTITY"

echo "== Building app bundle (${ARCH}) =="
npm run build
npx electron-builder --mac dir --"$ARCH" \
  --publish never \
  -c.mac.notarize=false \
  -c.mac.hardenedRuntime=true \
  -c.mac.identity="$IDENTITY"

echo "== Verifying signature =="
codesign --verify --strict --deep --verbose=2 "$APP_PATH"

# The microphone entitlement is what lets Claude Code's voice input prompt at
# all, so fail loudly rather than shipping a build that silently cannot record.
if codesign -d --entitlements - --xml "$APP_PATH" 2>/dev/null \
    | plutil -p - 2>/dev/null \
    | grep -q 'com.apple.security.device.audio-input'; then
  echo "microphone entitlement: present"
else
  echo "error: com.apple.security.device.audio-input is missing from the signed app." >&2
  echo "       Check the mac.entitlements entry in electron-builder.yml." >&2
  exit 1
fi

if [ "$INSTALL" -eq 1 ]; then
  echo "== Installing to /Applications =="
  rm -rf /Applications/Clave.app
  cp -R "$APP_PATH" /Applications/Clave.app
  echo "Installed /Applications/Clave.app"
  echo
  echo "If voice input has never been granted for this bundle id, clear the"
  echo "cached denial once, then relaunch:"
  echo "  tccutil reset Microphone com.clave.app"
else
  echo "== Done =="
  echo "App: $APP_PATH"
  echo
  echo "Install it with:"
  echo "  npm run build:mac:local -- --install"
fi
