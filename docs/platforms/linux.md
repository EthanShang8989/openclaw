---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: "Linux App"
---

# Linux App

The Gateway is fully supported on Linux. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

Native Linux companion apps are planned. Contributions are welcome if you want to help build one.

## Beginner quick path (VPS)

1. Install Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. From your laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Open `http://127.0.0.1:18789/` and paste your token

Step-by-step VPS guide: [exe.dev](/platforms/exe-dev)

## Install

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- Optional flows: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Use one of these:

```
openclaw onboard --install-daemon
```

Or:

```
openclaw gateway install
```

Or:

```
openclaw configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
openclaw doctor
```

## System control (systemd user unit)

OpenClaw installs a systemd **user** service by default. Use a **system**
service for shared or always-on servers. The full unit example and guidance
live in the [Gateway runbook](/gateway).

Minimal setup:

Create `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

## Troubleshooting

Common issues when deploying on Linux VPS:

### NVM PATH not available in systemd

NVM only loads in interactive shells. systemd services cannot find `node`.

**Solution A**: Create symlinks in `/usr/local/bin`:

```bash
NODE_DIR=/root/.nvm/versions/node/v22.22.0/bin
ln -sf $NODE_DIR/node /usr/local/bin/node
ln -sf $NODE_DIR/npm /usr/local/bin/npm
ln -sf $NODE_DIR/npx /usr/local/bin/npx
ln -sf $NODE_DIR/pnpm /usr/local/bin/pnpm
```

**Solution B**: Create `/etc/profile.d/nvm.sh` for interactive sessions:

```bash
cat > /etc/profile.d/nvm.sh << 'EOF'
if [ -d "/root/.nvm/versions/node" ]; then
    NODE_PATH=$(find /root/.nvm/versions/node -maxdepth 1 -type d -name "v*" | sort -V | tail -1)
    [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH/bin:$PATH"
fi
EOF
```

### Missing lsof

`openclaw gateway --force` requires lsof to check port usage.

```bash
apt install -y lsof
```

### Claude CLI cannot run as root

`--dangerously-skip-permissions` fails with root/sudo privileges.

**Solution**: Create a dedicated user:

```bash
useradd -r -m -s /bin/bash openclaw
# Copy Claude CLI credentials
cp -r /root/.claude /home/openclaw/
cp /root/.claude.json /home/openclaw/
chown -R openclaw:openclaw /home/openclaw/.claude*
```

Run the systemd service as that user (`User=openclaw`).

### Telegram pairing required repeatedly

The credentials file (`~/.openclaw/credentials/telegram-allowFrom.json`) has wrong ownership.

**Solution**: Ensure the file is owned by the service user:

```bash
chown -R openclaw:openclaw /home/openclaw/.openclaw/credentials/
```

### Claude CLI not found (spawn claude ENOENT)

The `claude` binary is not in PATH for the service user.

**Solution**: Create symlink or reinstall:

```bash
# Option 1: Symlink (if already installed globally)
ln -sf /root/.nvm/versions/node/v22.22.0/bin/claude /usr/local/bin/claude

# Option 2: Reinstall for the service user
npm install -g @anthropic-ai/claude-code
```

### Gateway auth token not configured

Service fails with "gateway auth token not configured".

**Solution**: Generate and set the token:

```bash
# Generate token
TOKEN=$(openssl rand -hex 32)
echo $TOKEN > /root/.openclaw-token

# Add to systemd service
Environment=OPENCLAW_GATEWAY_TOKEN=$TOKEN
```

### NVM directory not accessible

If NVM is installed under `/root`, other users cannot access it.

**Solution**: Make NVM directories accessible:

```bash
chmod 755 /root
chmod 755 /root/.nvm
chmod -R 755 /root/.nvm/versions
```
