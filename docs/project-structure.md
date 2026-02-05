---
title: "Project Structure"
description: "OpenClaw codebase organization, modules, and plugin architecture"
---

# Project Structure

## Source Code Organization

```
src/
├── cli/              # CLI wiring and entry points
├── commands/         # CLI commands implementation
├── gateway/          # Gateway server and WebSocket handling
├── agents/           # Agent runners (Claude CLI, Codex, Pi)
├── provider-web.ts   # Web provider
├── infra/            # Infrastructure utilities
├── media/            # Media pipeline
├── telegram/         # Telegram channel
├── discord/          # Discord channel
├── slack/            # Slack channel
├── signal/           # Signal channel
├── imessage/         # iMessage channel
├── web/              # WhatsApp Web channel
├── channels/         # Shared channel logic
├── routing/          # Message routing
└── terminal/         # Terminal UI (tables, palette, progress)
```

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Main source code (TypeScript ESM) |
| `dist/` | Built output |
| `docs/` | Documentation (Mintlify) |
| `extensions/` | Plugin/extension packages |
| `apps/` | Native apps (iOS, Android, macOS) |
| `scripts/` | Build and utility scripts |

## Tests

- Colocated with source: `*.test.ts`
- E2E tests: `*.e2e.test.ts`
- Framework: Vitest

## Plugins & Extensions

Extensions live under `extensions/*` as workspace packages:

```
extensions/
├── msteams/       # Microsoft Teams
├── matrix/        # Matrix protocol
├── zalo/          # Zalo (business)
├── zalouser/      # Zalo (user)
└── voice-call/    # Voice calling
```

### Plugin Rules

- Keep plugin-only deps in the extension's `package.json`
- Do not add them to root `package.json` unless core uses them
- Install runs `npm install --omit=dev` in plugin dir
- Runtime deps must live in `dependencies`
- Avoid `workspace:*` in `dependencies` (breaks npm install)
- Put `openclaw` in `devDependencies` or `peerDependencies`

## Messaging Channels

When refactoring shared logic (routing, allowlists, pairing, command gating, onboarding), consider **all** channels:

### Core Channels
- Telegram: `src/telegram/`
- Discord: `src/discord/`
- Slack: `src/slack/`
- Signal: `src/signal/`
- iMessage: `src/imessage/`
- WhatsApp Web: `src/web/`

### Extension Channels
- MS Teams: `extensions/msteams/`
- Matrix: `extensions/matrix/`
- Zalo: `extensions/zalo/`, `extensions/zalouser/`
- Voice: `extensions/voice-call/`

### Channel Documentation
- Core channel docs: `docs/channels/`
- When adding channels/extensions/apps/docs, review `.github/labeler.yml` for label coverage

## Installers

Installers served from `https://openclaw.ai/*` live in the sibling repo `../openclaw.ai`:
- `public/install.sh`
- `public/install-cli.sh`
- `public/install.ps1`
