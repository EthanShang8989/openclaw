import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox/types.js";
import type { DetectedInteraction } from "./cli-runner/interaction-manager.js";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import { shouldLogVerbose } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { buildDockerExecArgs, buildSandboxEnv } from "./bash-tools.shared.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import {
  appendImagePathsToPrompt,
  buildCliArgs,
  buildSystemPrompt,
  cleanupResumeProcesses,
  cleanupSuspendedCliProcesses,
  enqueueCliRun,
  normalizeCliModel,
  parseCliJson,
  parseCliJsonl,
  parseCliStreamJsonl,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./cli-runner/helpers.js";
import { writeCliEventsToSession } from "./cli-runner/session-writer.js";
import { resolveOpenClawDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";

const log = createSubsystemLogger("agent/claude-cli");

const DEFAULT_SANDBOX_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin";

function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve whether CLI should run in sandbox based on backend config and context.
 */
function shouldRunCliInSandbox(
  backend: import("../config/types.js").CliBackendConfig,
  sandboxContext?: SandboxContext,
): boolean {
  if (backend.sandboxMode === "off") {
    return false;
  }
  if (backend.sandboxMode === "always") {
    return Boolean(sandboxContext?.enabled);
  }
  // Default: "inherit" - use sandbox if session is sandboxed
  return Boolean(sandboxContext?.enabled);
}

/**
 * Build docker exec command for running CLI in sandbox.
 */
function buildCliSandboxCommand(params: {
  sandbox: SandboxContext;
  backend: import("../config/types.js").CliBackendConfig;
  command: string;
  args: string[];
  env: Record<string, string>;
}): string[] {
  // Merge sandbox env with backend-specific overrides
  const sandboxEnv = buildSandboxEnv({
    defaultPath: DEFAULT_SANDBOX_PATH,
    paramsEnv: params.env,
    sandboxEnv: {
      ...params.sandbox.docker.env,
      ...params.backend.sandboxOverrides?.env,
    },
    containerWorkdir: params.sandbox.containerWorkdir,
  });

  // Build the full CLI command string (command + args), always single-quote args.
  const cliCommand = [params.command, ...params.args].map((arg) => quoteShellArg(arg)).join(" ");

  return buildDockerExecArgs({
    containerName: params.sandbox.containerName,
    command: cliCommand,
    workdir: params.sandbox.containerWorkdir,
    env: sandboxEnv,
    tty: false,
  });
}

/**
 * CLI 交互恢复时传入的工具结果
 */
export type CliToolResultInput = {
  /** 工具调用 ID（对应 AskUserQuestion 的 tool_use_id） */
  toolCallId: string;
  /** 用户回答内容 */
  result: string;
};

/**
 * CLI Agent 运行结果（扩展自 EmbeddedPiRunResult）
 */
export type CliAgentRunResult = EmbeddedPiRunResult & {
  /** 检测到的待交互请求（AskUserQuestion 等） */
  pendingInteraction?: DetectedInteraction;
};

export async function runCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: ImageContent[];
  sandboxContext?: SandboxContext;
  /** 交互恢复时传入的工具结果（用于回答 AskUserQuestion） */
  toolResult?: CliToolResultInput;
}): Promise<CliAgentRunResult> {
  const started = Date.now();
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const backend = backendResolved.config;
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backend);
  const modelDisplay = `${params.provider}/${modelId}`;

  // Only disable tools if enableTools is not explicitly set to true
  const toolsDisabledPrompt = backend.enableTools
    ? undefined
    : "Tools are disabled in this session. Do not call tools.";
  const extraSystemPrompt = [params.extraSystemPrompt?.trim(), toolsDisabledPrompt]
    .filter(Boolean)
    .join("\n");

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

  const { sessionId: cliSessionIdToSend, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: params.cliSessionId,
  });
  const useResume = Boolean(
    params.cliSessionId &&
    cliSessionIdToSend &&
    backend.resumeArgs &&
    backend.resumeArgs.length > 0,
  );
  const sessionIdSent = cliSessionIdToSend
    ? useResume || Boolean(backend.sessionArg) || Boolean(backend.sessionArgs?.length)
      ? cliSessionIdToSend
      : undefined
    : undefined;
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew,
    systemPrompt,
  });

  let imagePaths: string[] | undefined;
  let cleanupImages: (() => Promise<void>) | undefined;
  let prompt = params.prompt;
  if (params.images && params.images.length > 0) {
    const imagePayload = await writeCliImages(params.images);
    imagePaths = imagePayload.paths;
    cleanupImages = imagePayload.cleanup;
    if (!backend.imageArg) {
      prompt = appendImagePathsToPrompt(prompt, imagePaths);
    }
  }

  const { argsPrompt, stdin } = resolvePromptInput({
    backend,
    prompt,
  });

  // 构建 stdin 输入：如果有 toolResult，构造 tool_result 消息
  let stdinPayload = stdin ?? "";
  if (params.toolResult && useResume) {
    // 使用 stream-json 格式传入 tool_result
    // Claude CLI 期望 stdin 是 JSONL 格式的用户消息
    const toolResultMessage = {
      type: "tool_result",
      tool_use_id: params.toolResult.toolCallId,
      content: params.toolResult.result,
    };
    stdinPayload = JSON.stringify(toolResultMessage);
    log.info(
      `cli resume with tool result: toolCallId=${params.toolResult.toolCallId} ` +
        `resultChars=${params.toolResult.result.length}`,
    );
  }
  const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", cliSessionIdToSend ?? ""))
    : baseArgs;
  const args = buildCliArgs({
    backend,
    baseArgs: resolvedArgs,
    modelId: normalizedModel,
    sessionId: cliSessionIdToSend,
    systemPrompt: systemPromptArg,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
  });

  const serialize = backend.serialize ?? true;
  const queueKey = serialize ? backendResolved.id : `${backendResolved.id}:${params.runId}`;

  try {
    const output = await enqueueCliRun(queueKey, async () => {
      log.info(
        `cli exec: provider=${params.provider} model=${normalizedModel} promptChars=${params.prompt.length}`,
      );
      const logOutputText = isTruthyEnvValue(process.env.OPENCLAW_CLAUDE_CLI_LOG_OUTPUT);
      if (logOutputText) {
        const logArgs: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i] ?? "";
          if (arg === backend.systemPromptArg) {
            const systemPromptValue = args[i + 1] ?? "";
            logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
            i += 1;
            continue;
          }
          if (arg === backend.sessionArg) {
            logArgs.push(arg, args[i + 1] ?? "");
            i += 1;
            continue;
          }
          if (arg === backend.modelArg) {
            logArgs.push(arg, args[i + 1] ?? "");
            i += 1;
            continue;
          }
          if (arg === backend.imageArg) {
            logArgs.push(arg, "<image>");
            i += 1;
            continue;
          }
          logArgs.push(arg);
        }
        if (argsPrompt) {
          const promptIndex = logArgs.indexOf(argsPrompt);
          if (promptIndex >= 0) {
            logArgs[promptIndex] = `<prompt:${argsPrompt.length} chars>`;
          }
        }
        log.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
      }

      const env = (() => {
        const next = { ...process.env, ...backend.env };
        for (const key of backend.clearEnv ?? []) {
          delete next[key];
        }
        // 过滤掉 undefined 值以满足 Record<string, string> 类型
        const filtered: Record<string, string> = {};
        for (const [key, value] of Object.entries(next)) {
          if (value !== undefined) {
            filtered[key] = value;
          }
        }
        return filtered;
      })();

      // Cleanup suspended processes that have accumulated (regardless of sessionId)
      await cleanupSuspendedCliProcesses(backend);
      if (useResume && cliSessionIdToSend) {
        await cleanupResumeProcesses(backend, cliSessionIdToSend);
      }

      // Determine if CLI should run in sandbox
      const useSandbox = shouldRunCliInSandbox(backend, params.sandboxContext);
      let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;

      if (useSandbox && params.sandboxContext?.enabled) {
        // Run CLI inside sandbox container via docker exec
        const dockerArgs = buildCliSandboxCommand({
          sandbox: params.sandboxContext,
          backend,
          command: backend.command,
          args,
          env,
        });
        log.info(
          `cli sandbox exec: container=${params.sandboxContext.containerName} command=${backend.command}`,
        );
        result = await runCommandWithTimeout(["docker", ...dockerArgs], {
          timeoutMs: params.timeoutMs,
          cwd: workspaceDir,
          input: stdinPayload,
        });
      } else {
        // Run CLI directly on host
        result = await runCommandWithTimeout([backend.command, ...args], {
          timeoutMs: params.timeoutMs,
          cwd: workspaceDir,
          env,
          input: stdinPayload,
        });
      }

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (logOutputText) {
        if (stdout) {
          log.info(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          log.info(`cli stderr:\n${stderr}`);
        }
      }
      if (shouldLogVerbose()) {
        if (stdout) {
          log.debug(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          log.debug(`cli stderr:\n${stderr}`);
        }
      }

      if (result.code !== 0) {
        const err = stderr || stdout || "CLI failed.";
        const reason = classifyFailoverReason(err) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(err, {
          reason,
          provider: params.provider,
          model: modelId,
          status,
        });
      }

      const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;

      if (outputMode === "text") {
        return { text: stdout, sessionId: undefined };
      }
      if (outputMode === "jsonl") {
        const parsed = parseCliJsonl(stdout, backend);
        return parsed ?? { text: stdout };
      }
      if (outputMode === "stream-jsonl") {
        const parsed = parseCliStreamJsonl(stdout, backend);
        if (parsed) {
          // 将工具调用和结果写入会话文件（用于记忆系统索引）
          if (params.sessionFile && (parsed.toolUses.length > 0 || parsed.toolResults.length > 0)) {
            await writeCliEventsToSession({
              sessionFile: params.sessionFile,
              sessionId: parsed.sessionId ?? params.sessionId,
              cwd: workspaceDir,
              events: parsed,
              provider: params.provider,
              model: modelId,
            });
          }
          return {
            text: parsed.text,
            sessionId: parsed.sessionId,
            usage: parsed.usage,
            pendingInteraction: parsed.pendingInteraction,
          };
        }
        return { text: stdout };
      }

      const parsed = parseCliJson(stdout, backend);
      return parsed ?? { text: stdout };
    });

    const text = output.text?.trim();
    const payloads = text ? [{ text }] : undefined;

    // 提取 pendingInteraction（仅 stream-jsonl 输出模式有此字段）
    const pendingInteraction =
      "pendingInteraction" in output ? output.pendingInteraction : undefined;

    return {
      payloads,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: output.sessionId ?? sessionIdSent ?? params.sessionId ?? "",
          provider: params.provider,
          model: modelId,
          usage: output.usage,
        },
      },
      pendingInteraction,
    };
  } catch (err) {
    if (err instanceof FailoverError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isFailoverErrorMessage(message)) {
      const reason = classifyFailoverReason(message) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, {
        reason,
        provider: params.provider,
        model: modelId,
        status,
      });
    }
    throw err;
  } finally {
    if (cleanupImages) {
      await cleanupImages();
    }
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
  sandboxContext?: SandboxContext;
  toolResult?: CliToolResultInput;
}): Promise<CliAgentRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
    sandboxContext: params.sandboxContext,
    toolResult: params.toolResult,
  });
}
