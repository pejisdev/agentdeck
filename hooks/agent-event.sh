#!/bin/bash
# Hook Claude Code (Notification, Stop, UserPromptSubmit, PostToolUse) : dans un emplacement Agent Deck
# (AGENTDECK_SESSION défini par tmux), note l'état de l'agent pour la pastille « à toi de jouer ».
#   permission : autorisation ou question en attente     done : tour terminé, l'agent attend
#   working    : tu as répondu / un outil tourne
# Pour « done », garde un extrait du dernier message de l'agent (retour vocal). Sans effet hors d'Agent Deck.
# Toujours exit 0 pour ne jamais gêner Claude.
[ -n "$AGENTDECK_SESSION" ] || exit 0
case "$1" in permission|done|working) ;; *) exit 0 ;; esac
case "$AGENTDECK_SESSION" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
dir="$(cd "$(dirname "$0")/.." && pwd)/data/events"
mkdir -p "$dir"
now=$(date +%s%3N)
msg='""'
if [ "$1" = done ] && command -v jq >/dev/null; then
  msg=$(timeout 3 jq -c '(.last_assistant_message // "") | tostring | .[0:1200]' 2>/dev/null) || msg='""'
  [ -n "$msg" ] || msg='""'
fi
tmp="$dir/.$AGENTDECK_SESSION.$$"
printf '{"kind":"%s","at":%s,"message":%s}' "$1" "$now" "$msg" > "$tmp" && mv -f "$tmp" "$dir/$AGENTDECK_SESSION"
exit 0
