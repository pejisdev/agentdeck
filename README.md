# Agent Deck

A self-hosted web cockpit to run several [Claude Code](https://claude.com/claude-code) agents per project on a VPS, from any browser.

Projects on the left, up to four agents per project in the middle, a file tree and editor on the right. Agents live in tmux sessions, so they survive page reloads, server restarts and even reboots.

> The interface is currently in French. Contributions for i18n are welcome.

## Features

- **Up to 4 agents per project**, each in its own terminal, with resume of previous conversations.
- **Persistent sessions**: agents run in tmux and keep working while you're away. Reopen the browser and pick up where they are.
- **Attention badges and notifications** when an agent finishes or waits for an answer.
- **Several Claude accounts** with plan usage bars (same data as `/usage` in Claude Code) and optional automatic switch when one account is saturated.
- **GitHub integration** (`gh`): clone any repo you have access to in one click, or create a new repo straight from the UI.
- **Free agent**: a scratch space for general questions, outside any project.
- **File tree + Monaco editor** with git status and diff view; upload files by drag and drop.
- **Paste or drop files into a terminal**: the file lands in the project and its path is typed for the agent.
- **Voice control** (optional, needs an OpenAI key): talk to your agents, get spoken replies.
- Single-user, token-protected, listens on localhost only.

## Requirements

- A Linux server (tested on Ubuntu 22.04/24.04) with Node.js 20+, tmux, git, jq and the GitHub CLI (`gh`). The installer takes care of these on Debian/Ubuntu.
- A Claude subscription (Pro/Max) or API access, logged in through Claude Code.

## Install

```bash
git clone https://github.com/pejisdev/agentdeck.git ~/agentdeck
~/agentdeck/install.sh
```

The script installs the dependencies, creates a `systemd` service (`agentdeck.service`) and prints the URL and the access token. The server only listens on `127.0.0.1:7700`. To reach it:

```bash
# SSH tunnel from your machine
ssh -N -L 7700:127.0.0.1:7700 user@your-server
# then open http://localhost:7700/?token=<token>
```

or put a reverse proxy / Cloudflare Tunnel with HTTPS in front of it.

Then, in the UI: **Comptes Claude → Se connecter**, and **+ Ajouter un projet → Connecter GitHub** to clone your repos.

## Configuration

Everything lives in `data/` (git-ignored):

| File | Content |
|---|---|
| `data/config.json` | project roots, accounts, commands, auto-resume, voice settings |
| `data/token` | the access token (regenerate by deleting it and restarting) |
| `data/secrets.env` | `OPENAI_API_KEY=...` for voice transcription and speech |

Useful environment variables: `PORT` (default 7700), `HOST` (default 127.0.0.1).

## Security notes

- **Agents are launched with `--dangerously-skip-permissions` by default.** This is deliberate: the cockpit is meant for unattended work on a dedicated VPS. Don't run it on a machine holding anything you're not ready to let an agent touch. You can change the commands in `data/config.json`.
- The web UI gives full terminal access to whoever holds the token. Keep it behind SSH or an authenticated HTTPS proxy. Never expose port 7700 directly.
- Claude credentials stay in `~/.claude` (and `~/.claude-accounts/<name>` for extra accounts) on the server.

## How it works

- `server.js`: Express + WebSocket server. Spawns `tmux` sessions on a dedicated socket (`agentdeck`), attaches them to the browser through `node-pty` and xterm.js.
- `hooks/`: small Claude Code hooks, installed into `~/.claude/settings.json` at startup, that report agent state (working / waiting / done) and the current conversation id.
- `public/`: vanilla JS front end, no build step.

## License

MIT
