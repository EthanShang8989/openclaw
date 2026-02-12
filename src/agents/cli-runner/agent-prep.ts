/**
 * Agent 运行前的公共准备逻辑
 *
 * CLI runner（runCliAgent）和 SDK runner（runSdkAgent）共享的
 * workspace 解析、system prompt 构建、CLAUDE.md 写入等。
 */

import fs from "node:fs";
import path from "node:path";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { resolveCliBackendConfig, type ResolvedCliBackend } from "../cli-backends.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import { getSubagentStatusForPrompt } from "../subagent-manager.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { buildSystemPrompt, normalizeCliModel } from "./helpers.js";

export type AgentPrepResult = {
  workspaceDir: string;
  backend: ResolvedCliBackend;
  modelId: string;
  normalizedModel: string;
  modelDisplay: string;
  systemPrompt: string;
};

export async function prepareAgentRun(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  runId: string;
  /** 调用者标识，用于日志前缀 */
  logSubsystem: string;
}): Promise<AgentPrepResult> {
  const log = createSubsystemLogger(params.logSubsystem);

  // ── workspace 解析 ──
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const workspaceDir = workspaceResolution.workspaceDir;
  if (workspaceResolution.usedFallback) {
    const redacted = redactRunIdentifier(workspaceDir);
    log.warn(
      `[workspace-fallback] reason=${workspaceResolution.fallbackReason} run=${params.runId} workspace=${redacted}`,
    );
  }

  // ── backend + model ──
  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const backend = backendResolved.config;
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backend);
  const modelDisplay = `${params.provider}/${modelId}`;

  // ── extra system prompt ──
  const toolsDisabledPrompt = backend.enableTools
    ? undefined
    : "Tools are disabled in this session. Do not call tools.";
  const extraSystemPrompt = [params.extraSystemPrompt?.trim(), toolsDisabledPrompt]
    .filter(Boolean)
    .join("\n");

  // ── CLAUDE.md subagent 状态写入 ──
  const subagentStatus = params.sessionKey
    ? getSubagentStatusForPrompt(params.sessionKey)
    : undefined;
  if (subagentStatus) {
    const claudeMdPath = path.join(workspaceDir, "CLAUDE.md");
    try {
      await fs.promises.writeFile(
        claudeMdPath,
        `# OpenCLAW Runtime Status\n\n${subagentStatus}\n`,
        "utf-8",
      );
    } catch (e) {
      log.warn(
        `[subagent-status] failed to write CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ── bootstrap context + system prompt ──
  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    modelDisplay,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
  });

  return {
    workspaceDir,
    backend: backendResolved,
    modelId,
    normalizedModel,
    modelDisplay,
    systemPrompt,
  };
}
