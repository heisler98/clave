#!/bin/bash
# Preflight for UAT of the iPad remote client against this fork.
#
# Six things have to be true before the iPad can reach a session, and most of
# them fail silently or with an unrelated-looking error. This checks all six and
# tells you which one is wrong.
#
#   ./scripts/uat-preflight.sh
set -uo pipefail

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }

SUPPORT="$HOME/Library/Application Support/clave"
FAILED=0

bold "1. Remote Login (SSH) on this Mac"
if nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1; then
  ok "port 22 is open"
else
  bad "port 22 is closed, so the iPad cannot reach this Mac at all"
  info "System Settings > General > Sharing > Remote Login, and allow your user."
  FAILED=1
fi

bold "2. Which Clave is running"
INSTALLED="$(pgrep -x Clave 2>/dev/null | head -1)"
FORK="$(pgrep -f 'electron .*clave/(out|node_modules/electron)' 2>/dev/null | head -1)"
if [[ -n "$INSTALLED" && -n "$FORK" ]]; then
  bad "both the installed Clave (pid $INSTALLED) and a dev build are running"
  info "They share one config directory and one MCP port. Quit the installed app."
  FAILED=1
elif [[ -n "$INSTALLED" ]]; then
  bad "the installed Clave is running (pid $INSTALLED). It has no remote access."
  info "Quit it, then start the fork with: npm run dev"
  info "Your tmux sessions survive the quit and are offered back on relaunch."
  FAILED=1
elif [[ -n "$FORK" ]]; then
  ok "a dev build of the fork is running"
else
  bad "no Clave is running"
  info "Start the fork with: npm run dev"
  FAILED=1
fi

bold "3. Remote access enabled in the fork"
STATE="$SUPPORT/remote-server.json"
if [[ -f "$STATE" ]]; then
  ENABLED="$(python3 -c "import json;print(json.load(open('$STATE')).get('enabled'))" 2>/dev/null)"
  PORT="$(python3 -c "import json;print(json.load(open('$STATE')).get('port'))" 2>/dev/null)"
  APPROVAL="$(python3 -c "import json;print(json.load(open('$STATE')).get('requireApproval'))" 2>/dev/null)"
  if [[ "$ENABLED" == "True" ]]; then
    ok "enabled, listening on 127.0.0.1:$PORT"
    [[ "$APPROVAL" == "True" ]] && info "New devices need approving in Settings > General > Remote Access > Devices."
  else
    bad "remote access is off (it ships off by default)"
    info "Settings > General > Remote Access > Enable remote access."
    FAILED=1
  fi
  MODE="$(stat -f '%Lp' "$STATE")"
  [[ "$MODE" == "600" ]] && ok "token file is 0600" || bad "token file is $MODE, expected 600"
else
  bad "no remote-server.json yet, so remote access has never been turned on"
  info "Start the fork, then Settings > General > Remote Access."
  FAILED=1
fi

bold "4. Your iPad's key is authorised"
if [[ -f "$HOME/.ssh/authorized_keys" ]]; then
  COUNT="$(grep -c '^ssh-' "$HOME/.ssh/authorized_keys" 2>/dev/null || echo 0)"
  ok "authorized_keys exists with $COUNT key(s)"
  grep -q 'clave-ipad' "$HOME/.ssh/authorized_keys" 2>/dev/null \
    && ok "one of them looks like the iPad's (comment contains clave-ipad)" \
    || info "None is commented clave-ipad. Add the CLAVE-PUBKEY line the iPad prints at launch."
  DIR_MODE="$(stat -f '%Lp' "$HOME/.ssh")"
  KEY_MODE="$(stat -f '%Lp' "$HOME/.ssh/authorized_keys")"
  [[ "$DIR_MODE" == "700" ]] || bad "~/.ssh is $DIR_MODE, sshd wants 700"
  [[ "$KEY_MODE" == "600" ]] || bad "authorized_keys is $KEY_MODE, sshd wants 600"
else
  bad "~/.ssh/authorized_keys does not exist"
  info "Run ./run-on-ipad.sh in the clave-ios repo, copy the highlighted CLAVE-PUBKEY line, then:"
  info "  mkdir -p ~/.ssh && chmod 700 ~/.ssh"
  info "  printf '%s\\n' 'ssh-ed25519 AAAA... clave-ipad' >> ~/.ssh/authorized_keys"
  info "  chmod 600 ~/.ssh/authorized_keys"
  FAILED=1
fi

bold "5. How the iPad should address this Mac"
if command -v tailscale >/dev/null 2>&1 && tailscale ip -4 >/dev/null 2>&1; then
  ok "Tailscale is up: $(tailscale ip -4 | head -1)"
  info "Use that address in the iPad app. It works off your LAN without exposing SSH."
else
  info "Tailscale is not up. On the same network you can use $(scutil --get LocalHostName 2>/dev/null).local"
  info "Avoid forwarding port 22 from the internet."
fi
info "Username: $(whoami)   Port: 22"

bold "6. Sessions available to attach"
if command -v tmux >/dev/null 2>&1; then
  N="$(tmux -L clave list-sessions 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$N" -gt 0 ]]; then
    ok "$N tmux-backed session(s) on socket clave"
    info "Only tmux-backed sessions can be attached. Persistent sessions must stay on."
  else
    bad "no tmux sessions on socket clave"
    info "Open a session in Clave with persistent sessions (tmux) enabled."
    FAILED=1
  fi
else
  bad "tmux is not installed, so no session can be attached"
  FAILED=1
fi

echo
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m%s\033[0m\n' "Ready for UAT."
else
  printf '\033[33m%s\033[0m\n' "Fix the ✗ items above, then run this again."
fi
exit $FAILED
