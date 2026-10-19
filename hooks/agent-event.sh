#!/bin/bash
# Hook Claude Code (Notification, Stop, UserPromptSubmit, PreToolUse, PostToolUse) : dans un emplacement Agent Deck
# (AGENTDECK_SESSION défini par tmux), note l'état de l'agent pour la pastille « à toi de jouer ».
#   permission : autorisation en attente     question : l'agent te pose une question (AskUserQuestion)
#   done       : tour terminé, l'agent attend   working : tu as répondu / un outil tourne
# Pour « done », garde un extrait du dernier message de l'agent (retour vocal) ; pour « question », l'intitulé.
# Sans effet hors d'Agent Deck.
# Toujours exit 0 pour ne jamais gêner Claude.
[ -n "$AGENTDECK_SESSION" ] || exit 0
case "$1" in permission|question|done|working) ;; *) exit 0 ;; esac
# Nom de l'emplacement : demandé à tmux (l'agent a pu être renuméroté depuis son lancement, l'env ne bouge pas)
sess="$AGENTDECK_SESSION"
if [ -n "$TMUX" ] && [ -n "$TMUX_PANE" ]; then
  s=$(timeout 2 tmux -S "${TMUX%%,*}" display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) && [ -n "$s" ] && sess="$s"
fi
case "$sess" in *[!A-Za-z0-9_-]*|"") exit 0 ;; esac
dir="$(cd "$(dirname "$0")/.." && pwd)/data/events"
mkdir -p "$dir"
now=$(date +%s%3N)
msg='""'
if command -v jq >/dev/null; then
  case "$1" in
    done) msg=$(timeout 3 jq -c '(.last_assistant_message // "") | tostring | .[0:1200]' 2>/dev/null) || msg='""' ;;
    question) msg=$(timeout 3 jq -c '[.tool_input.questions[]?.question // empty] | join(" — ") | .[0:1200]' 2>/dev/null) || msg='""' ;;
  esac
  [ -n "$msg" ] || msg='""'
fi
# Une question en attente (avec son intitulé) n'est pas écrasée par le « permission » que Claude émet ~6 s plus tard
# ni par un « done » (idle_prompt) : seule la réponse (working) la lève
if [ "$1" != working ] && [ "$1" != question ] && grep -q '"kind":"question"' "$dir/$sess" 2>/dev/null; then exit 0; fi
tmp="$dir/.$sess.$$"
printf '{"kind":"%s","at":%s,"message":%s}' "$1" "$now" "$msg" > "$tmp" && mv -f "$tmp" "$dir/$sess"
exit 0
