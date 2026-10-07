#!/bin/bash
# Hook SessionStart de Claude Code : dans un emplacement Agent Deck (AGENTDECK_SESSION défini par tmux),
# note l'ID de la conversation courante pour pouvoir la reprendre après un reboot. Sans effet ailleurs.
[ -n "$AGENTDECK_SESSION" ] || exit 0
id=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null)
case "$id" in
  *[!0-9a-f-]*|"") exit 0 ;;
esac
mkdir -p "$HOME/agentdeck/data/sessions"
printf '%s' "$id" > "$HOME/agentdeck/data/sessions/$AGENTDECK_SESSION"
exit 0
