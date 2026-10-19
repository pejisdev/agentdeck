#!/bin/bash
# Hook SessionStart de Claude Code : dans un emplacement Agent Deck (AGENTDECK_SESSION défini par tmux),
# note l'ID de la conversation courante pour pouvoir la reprendre après un reboot. Sans effet ailleurs.
[ -n "$AGENTDECK_SESSION" ] || exit 0
# Nom de l'emplacement : demandé à tmux (l'agent a pu être renuméroté depuis son lancement, l'env ne bouge pas)
sess="$AGENTDECK_SESSION"
if [ -n "$TMUX" ] && [ -n "$TMUX_PANE" ]; then
  s=$(timeout 2 tmux -S "${TMUX%%,*}" display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) && [ -n "$s" ] && sess="$s"
fi
case "$sess" in *[!A-Za-z0-9_-]*|"") exit 0 ;; esac
id=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null)
case "$id" in
  *[!0-9a-f-]*|"") exit 0 ;;
esac
dir="$(cd "$(dirname "$0")/.." && pwd)/data/sessions"
mkdir -p "$dir"
printf '%s' "$id" > "$dir/$sess"
exit 0
