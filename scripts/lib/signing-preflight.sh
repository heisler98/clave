#!/usr/bin/env bash
#
# Sourced, never executed. Answers one question before a ten-minute universal
# build gets a chance to answer it the slow way: can this machine produce a
# signed, notarized Clave?
#
# Two credential shapes are accepted, mirroring what electron-builder hands to
# notarytool:
#   • APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
#   • APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER   (App Store Connect key)
#
# The certificate comes from either CSC_LINK (a base64-encoded .p12, how CI
# does it) or a "Developer ID Application" identity already in the login
# keychain (how a local build does it — electron-builder finds it unaided, so
# nothing needs to be exported for a build on your own Mac).
#
# Set CLAVE_SKIP_NOTARIZE=1 to check the certificate only, for builds passing
# -c.mac.notarize=false.

# Load .env if present. `set -a` exports every assignment in it, which is what
# electron-builder and notarytool read.
clave_load_env() {
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi
}

_clave_missing=()

_clave_require() {
  local name="$1"
  [[ -n "${!name:-}" ]] || _clave_missing+=("$name")
}

# Returns non-zero and explains itself. Callers decide whether that is fatal.
clave_preflight_signing() {
  clave_load_env
  _clave_missing=()
  local ok=0

  # ── Certificate ─────────────────────────────────────────────────
  if [[ -n "${CSC_LINK:-}" ]]; then
    [[ -n "${CSC_KEY_PASSWORD:-}" ]] || _clave_missing+=("CSC_KEY_PASSWORD")
  elif ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    ok=1
    cat >&2 <<'EOS'

  No "Developer ID Application" certificate in the login keychain.

  That certificate is what makes a build installable on a Mac that is not
  yours; an "Apple Development" certificate cannot be notarized. Create one:

    Xcode > Settings > Accounts > (your Apple ID) > Manage Certificates
      > + > Developer ID Application

  Then re-run. Nothing needs to be exported — electron-builder finds the
  identity in the keychain on its own.

  For a build that only ever runs on this Mac, use `npm run build:mac:local`
  instead, which signs with the Apple Development certificate and skips
  notarization entirely.

EOS
  fi

  # ── Notarization credentials ────────────────────────────────────
  # Mirrors app-builder-lib's getNotarizeOptions, including its precedence: an
  # APPLE_ID present at all takes the app-specific-password path and the API key
  # is never consulted. It also skips notarization *silently* when nothing is
  # set, which is the case worth catching here.
  if [[ "${CLAVE_SKIP_NOTARIZE:-0}" != "1" ]]; then
    if [[ -n "${APPLE_ID:-}" || -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
      _clave_require APPLE_ID
      _clave_require APPLE_APP_SPECIFIC_PASSWORD
      _clave_require APPLE_TEAM_ID
    elif [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_ID:-}" || -n "${APPLE_API_ISSUER:-}" ]]; then
      _clave_require APPLE_API_KEY
      _clave_require APPLE_API_KEY_ID
      _clave_require APPLE_API_ISSUER

      if [[ -n "${APPLE_API_KEY:-}" && ! -f "$APPLE_API_KEY" ]]; then
        ok=1
        echo >&2
        echo "  APPLE_API_KEY points at a file that is not there:" >&2
        echo "    $APPLE_API_KEY" >&2
        echo >&2
      fi
    else
      ok=1
      cat >&2 <<'EOS'

  No notarization credentials. electron-builder would skip notarization
  silently and hand you an unnotarized build, so this stops instead.

  Either an App Store Connect API key:

    APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
    APPLE_API_KEY_ID=XXXXXXXXXX
    APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000

  or an Apple ID with an app-specific password:

    APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID

EOS
    fi

    # One network round trip against the real service, because the alternative
    # is finding out after the build that the key lacks the role, the issuer is
    # wrong, or the .p8 is the wrong file.
    if [[ $ok -eq 0 && ${#_clave_missing[@]} -eq 0 && -n "${APPLE_API_KEY:-}" ]]; then
      local probe
      if ! probe="$(xcrun notarytool history \
            --key "$APPLE_API_KEY" \
            --key-id "$APPLE_API_KEY_ID" \
            --issuer "$APPLE_API_ISSUER" 2>&1)"; then
        ok=1
        {
          echo
          echo "  The App Store Connect key was rejected by the notary service:"
          echo
          sed 's/^/    /' <<< "$probe" | head -8
          echo
          echo "  Check the Issuer ID, and that the key has at least the"
          echo "  Developer role. A key that can upload builds can notarize."
          echo
        } >&2
      fi
    fi
  fi

  if [[ ${#_clave_missing[@]} -gt 0 ]]; then
    ok=1
    {
      echo
      echo "  Missing credentials: ${_clave_missing[*]}"
      echo
      echo "  Put them in .env at the repo root (gitignored). Start from the"
      echo "  template: cp .env.example .env"
      echo
      if [[ " ${_clave_missing[*]} " == *" APPLE_API_ISSUER "* ]]; then
        echo "  The Issuer ID is the UUID above the key list at App Store"
        echo "  Connect > Users and Access > Integrations > App Store Connect API."
        echo "  It is per-team, so it is the same for every key you generate."
        echo
      fi
      if [[ " ${_clave_missing[*]} " == *" APPLE_APP_SPECIFIC_PASSWORD "* ]]; then
        echo "  APPLE_APP_SPECIFIC_PASSWORD comes from appleid.apple.com >"
        echo "  Sign-In and Security > App-Specific Passwords. It is not your"
        echo "  Apple ID password, and notarytool rejects that one."
        echo
      fi
    } >&2
  fi

  return $ok
}
