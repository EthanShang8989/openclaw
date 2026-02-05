---
title: "Operations Runbook"
description: "Server operations, VM management, and deployment procedures"
---

# Operations Runbook

## exe.dev VM Operations

### Access

- Stable path: `ssh exe.dev` then `ssh vm-name`
- Assume SSH key is already set
- If SSH is flaky: use exe.dev web terminal or Shelley (web agent)
- Keep a tmux session for long operations

### Update OpenClaw

```bash
sudo npm i -g openclaw@latest
```

Note: Global install needs root on `/usr/lib/node_modules`

### Configuration

```bash
openclaw config set ...
```

Ensure `gateway.mode=local` is set.

### Discord Token

Store raw token only (no `DISCORD_BOT_TOKEN=` prefix).

### Restart Gateway

```bash
# Stop old gateway and start new one
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

### Verify Gateway

```bash
# Check channel status
openclaw channels status --probe

# Check port binding
ss -ltnp | rg 18789

# Check logs
tail -n 120 /tmp/openclaw-gateway.log
```

## Fly.io Operations

### Update Fly Deployment

```bash
fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"
fly machines restart e825232f34d058 -a flawd-bot
```

## macOS Operations

### Gateway Control

- Gateway runs only as the menubar app (no separate LaunchAgent)
- Restart via OpenClaw Mac app or `scripts/restart-mac.sh`
- **Do NOT** use ad-hoc tmux sessions for debugging
- Kill any temporary tunnels before handoff

### Verify/Kill Gateway

```bash
launchctl print gui/$UID | grep openclaw
```

Don't assume a fixed label.

### Query Logs

```bash
./scripts/clawlog.sh
```

Supports follow/tail/category filters. Expects passwordless sudo for `/usr/bin/log`.

### macOS App Rebuild

- **Do NOT** rebuild over SSH
- Rebuilds must run directly on the Mac

## Linux VPS Deployment

See [Linux Platform Guide](/platforms/linux) for:
- systemd service setup
- NVM PATH configuration
- Troubleshooting common issues

## Security Notes

### Credentials

- Web provider stores creds at `~/.openclaw/credentials/`
- Rerun `openclaw login` if logged out

### Sessions

- Pi sessions live under `~/.openclaw/sessions/`
- Base directory is not configurable

### Environment Variables

See `~/.profile`

### Never Commit

- Real phone numbers
- Videos
- Live configuration values

Use obviously fake placeholders in docs, tests, and examples.

## Shorthand Commands

### sync

If working tree is dirty:
1. Commit all changes (pick a sensible Conventional Commit message)
2. `git pull --rebase`
3. If rebase conflicts and cannot resolve: stop
4. Otherwise: `git push`
