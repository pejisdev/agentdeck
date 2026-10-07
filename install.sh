#!/bin/bash
# Installe (ou réinstalle) Agent Deck sur CE serveur. Relançable sans risque.
#   ssh ubuntu@mon-vps 'git clone https://github.com/pejisdev/agentdeck.git && agentdeck/install.sh'
# Ensuite : ouvre l'URL affichée, connecte Claude (bloc « Comptes ») et GitHub (« + Ajouter un projet »),
# clone tes dépôts d'un clic et c'est parti.
set -euo pipefail
cd "$(dirname "$0")"
DIR=$(pwd); USER_NAME=$(id -un); PORT=${PORT:-7700}
say() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
need_sudo() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

say "Paquets système (tmux, git, jq, gh)"
if command -v apt-get >/dev/null; then
  missing=()
  for p in tmux git jq curl; do command -v "$p" >/dev/null || missing+=("$p"); done
  if ! command -v gh >/dev/null; then
    need_sudo mkdir -p -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | need_sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | need_sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    missing+=(gh)
  fi
  if [ ${#missing[@]} -gt 0 ]; then need_sudo apt-get update -qq; need_sudo apt-get install -y -qq "${missing[@]}"; fi
else
  for p in tmux git jq gh; do command -v "$p" >/dev/null || echo "⚠ installe $p avec ton gestionnaire de paquets"; done
fi

say "Node.js ≥ 20"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | need_sudo bash -
  need_sudo apt-get install -y -qq nodejs
fi
node --version

say "Claude Code"
if ! command -v claude >/dev/null && [ ! -x "$HOME/.local/bin/claude" ]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
export PATH="$HOME/.local/bin:$PATH"; claude --version

say "Dépendances du serveur"
npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent
mkdir -p data

say "Service systemd (agentdeck.service)"
UNIT=/etc/systemd/system/agentdeck.service
need_sudo tee "$UNIT" >/dev/null <<UNIT
[Unit]
Description=Agent Deck
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PORT=$PORT
ExecStart=$(command -v node) server.js
Restart=always
# ne tue que node au redémarrage : le serveur tmux et les agents restent en vie
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
need_sudo systemctl daemon-reload
need_sudo systemctl enable --now agentdeck >/dev/null
need_sudo systemctl restart agentdeck
sleep 1
systemctl is-active --quiet agentdeck || { journalctl -u agentdeck -n 20 --no-pager; exit 1; }

# Le serveur installe lui-même ses hooks dans ~/.claude/settings.json au démarrage.
TOKEN=$(cat data/token)
cat <<MSG

✔ Agent Deck tourne sur http://127.0.0.1:$PORT (token : $TOKEN)

Il n'écoute qu'en local. Pour y accéder :
  • tunnel SSH depuis ton poste :  ssh -N -L $PORT:127.0.0.1:$PORT $USER_NAME@<ce-serveur>
    puis http://localhost:$PORT/?token=$TOKEN
  • ou un reverse proxy / tunnel Cloudflare en HTTPS devant 127.0.0.1:$PORT

Dans l'interface : « Comptes Claude » → Se connecter, puis « + Ajouter un projet » → Connecter GitHub → clique sur tes dépôts.
MSG
