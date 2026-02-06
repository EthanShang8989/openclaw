# OpenClaw Repository Guidelines

## 0. TL;DR（高频召回层）

- **项目简介**：OpenClaw 是一个多渠道 AI 助手网关，支持 Telegram/Discord/WhatsApp/Signal 等消息平台，可调用 Claude CLI/Codex 等 LLM backend
- **技术栈**：TypeScript (ESM) + Node 22+ + Bun（开发）+ Vitest + pnpm
- **关键入口**：
  - CLI: `src/cli/`，命令: `src/commands/`
  - Gateway: `src/gateway/`，Agent: `src/agents/`
  - 渠道: `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`
  - 扩展: `extensions/*`，文档: `docs/`
- **核心约定**：
  1. 用 `pnpm`（锁文件）+ `bun`（执行 TS）
  2. 提交前跑 `pnpm build && pnpm check`（开发阶段暂不跑测试）
  3. 用 `scripts/committer "<msg>" <file...>` 提交，避免手动 git add
  4. 渠道改动需考虑所有 built-in + extension channels
  5. 不编辑 `node_modules`，不更新 Carbon 依赖
  6. patched 依赖用精确版本（无 `^`/`~`）
  7. 文件 ≤500 LOC，逻辑复杂处加注释
  8. 多 agent 环境下不随意 stash/切分支/改 worktree
- **常用命令**：
  - 安装: `pnpm install`
  - 构建: `pnpm build`
  - 检查: `pnpm check`（lint + format）
  - 测试: `pnpm test`（暂不使用）
  - 开发运行: `pnpm openclaw ...` 或 `pnpm dev`
  - 打包 Mac: `scripts/package-mac-app.sh`
- **操作红线**：
  - 不改版本号除非明确同意
  - 不 npm publish 除非明确指示
  - 不 `git push --force` 到 main/master
  - streaming/partial 回复不发到外部消息平台

---

## 1. 工作方式（高频）

### 开发流程

- 本地跑 `pnpm openclaw ...` 测试 CLI
- Gateway 通过 systemd 管理: `./scripts/deploy-local.sh restart`
- 提交: `scripts/committer "<msg>" <file...>`
- PR 流程: temp 分支 → squash/rebase → 加 changelog + 感谢 → merge 回 main

### VPS 本地部署

- **代码位置**: `/home/openclaw/openclaw`（不是 `/opt/openclaw`）
- **服务管理**: systemd `openclaw.service`
- 部署脚本: `scripts/deploy-local.sh`
- 完整部署: `./scripts/deploy-local.sh deploy` (Git检查 + 构建 + 重启服务)
- 仅构建: `./scripts/deploy-local.sh build`
- 快速重启: `./scripts/deploy-local.sh restart` (仅重启服务)
- 查看日志: `./scripts/deploy-local.sh logs` 或 `sudo journalctl -u openclaw -f`
- 查看状态: `./scripts/deploy-local.sh status`

### 会话与重启机制

- **会话存储**: Claude CLI 会话存储在 `~/.claude/projects/-home-openclaw-openclaw/*.jsonl`
- **重启后恢复**: OpenCLAW 使用 `--resume {sessionId}` 自动恢复会话，重启不会丢失对话记忆
- **自我重启脚本**: `scripts/self-restart.sh --pull --notify`
  - 自动 git stash 保护未提交更改
  - 构建失败自动回滚，不重启
  - 健康检查失败（90秒超时）自动回滚到之前版本
- **健康检查**: systemd timer `openclaw-health-check.timer`，每 15 秒检查

### 代码风格

- TypeScript ESM，严格类型，避免 `any`
- Oxlint + Oxfmt 格式化
- 命名: 产品用 **OpenClaw**，CLI/包/路径用 `openclaw`
- CLI 进度条: `src/cli/progress.ts`，表格: `src/terminal/table.ts`
- 颜色: `src/terminal/palette.ts`，不硬编码

### Debug 速记

- 日志: `./scripts/clawlog.sh`（macOS unified log）
- VPS 日志: `sudo journalctl -u openclaw -f --no-pager`
- 会话日志: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- Claude CLI 会话: `~/.claude/projects/-home-openclaw-openclaw/*.jsonl`
- Gateway 状态: `openclaw channels status --probe`
- 迁移问题: `openclaw doctor`
- 健康检查日志: `sudo journalctl -u openclaw-health-check -f`

---

## 2. Pinned / Misc（硬规则区）

### Git 多 agent 安全

- 不随意 `git stash`/`git pull --rebase --autostash`
- 不切分支/checkout 除非明确要求
- 不改 `.worktrees/*`
- "push" 时可 rebase，"commit" 时只提交自己的改动
- 看到不认识的文件继续干活，只提交自己的

### 依赖管理

- `pnpm.patchedDependencies` 的依赖用精确版本
- 新增 patch/override/vendor 需明确批准
- 不更新 Carbon 依赖

### 工具 schema 约束

- 避免 `Type.Union`，不用 `anyOf`/`oneOf`/`allOf`
- 用 `stringEnum`/`optionalStringEnum` 代替
- 不用 `format` 作属性名（保留字）

### 自重启禁令

- **绝对禁止**通过 Bash 执行 `systemctl restart/stop/start openclaw` 或任何重启 OpenClaw 服务的命令
- **绝对禁止**未经用户确认就触发 gateway restart
- 遇到需要重启的情况（cron 报错、配置变更等）：
  1. 向用户说明问题和需要重启的原因
  2. 等待用户明确确认
  3. 用户确认后使用 `./scripts/deploy-local.sh restart`
- 发现错误时应**修复代码**而非重启服务

### CLI Backend 配置

- 默认配置: `src/agents/cli-backends.ts`
- Claude CLI: 使用 `--resume {sessionId}` 恢复会话
- Codex: 使用 `exec resume {sessionId}` 恢复会话
- Session mode: `always`（始终使用会话）/ `existing`（仅恢复已有会话）
- 用户配置: `~/.openclaw/openclaw.json` 中的 `agents.defaults.cliBackends`

### NPM 发布（需 1Password）

```bash
# tmux 中执行
eval "$(op signin --account my.1password.com)"
OTP=$(op read 'op://Private/Npmjs/one-time password?attribute=otp')
npm publish --access public --otp="$OTP"
```

### 版本位置

- CLI: `package.json`
- Android: `apps/android/app/build.gradle.kts`
- iOS: `apps/ios/Sources/Info.plist`
- macOS: `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- Docs: `docs/install/updating.md`

---

## 3. 按需查阅（索引层）

| 文档       | 路径                                                           | 说明                                  |
| ---------- | -------------------------------------------------------------- | ------------------------------------- |
| 项目结构   | [docs/project-structure.md](docs/project-structure.md)         | 目录组织、模块划分、插件机制          |
| 文档规范   | [docs/docs-guidelines.md](docs/docs-guidelines.md)             | Mintlify 链接、i18n、README           |
| 测试指南   | [docs/testing.md](docs/testing.md)                             | Vitest、覆盖率、live test、Docker E2E |
| PR 工作流  | [docs/pr-workflow.md](docs/pr-workflow.md)                     | Review vs Land、changelog、贡献者     |
| 运维手册   | [docs/runbook.md](docs/runbook.md)                             | exe.dev VM、Fly.io、服务器操作        |
| 发布流程   | [docs/reference/RELEASING.md](docs/reference/RELEASING.md)     | 版本、签名、notary                    |
| Mac 发布   | [docs/platforms/mac/release.md](docs/platforms/mac/release.md) | 打包、签名、上架                      |
| Linux 部署 | [docs/platforms/linux.md](docs/platforms/linux.md)             | systemd、NVM PATH、troubleshooting    |

---

## 4. 变更与维护规则

### 何时更新 TL;DR

- 新增/移除核心技术栈
- 新增/废弃常用命令
- 核心约定变化

### 何时更新 docs/

- 新增模块/渠道/扩展
- 详细流程变化（>10 行说明）
- 新增 troubleshooting 条目

### Pinned 区维护

- 只放"Claude 容易忘"且"频繁用到"的硬规则
- 超过 100 行就外置到 docs/runbook.md
