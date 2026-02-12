/**
 * SDK Agent 执行器（Phase C）
 *
 * 使用 @anthropic-ai/claude-agent-sdk 的 query() API 替代子进程调用，
 * 实现进程内 MCP 工具、流式输出等能力。
 *
 * 与 cli-runner.ts 的 runCliAgent() 接口兼容，可在 agent-runner-execution.ts
 * 中通过 useSdk 配置开关渐进切换。
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CliAgentRunResult, CliToolResultInput } from "./cli-runner.js";
import type { CliToolResultEvent, CliToolUseEvent } from "./cli-runner/helpers.js";
import type { DetectedInteraction, InteractionOption } from "./cli-runner/interaction-manager.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isRecord } from "../utils.js";
import { prepareAgentRun } from "./cli-runner/agent-prep.js";
import { appendImagePathsToPrompt, writeCliImages } from "./cli-runner/helpers.js";
import { writeCliEventsToSession } from "./cli-runner/session-writer.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { createOcSdkMcpServer } from "./oc-mcp/sdk-tools.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  isLikelyContextOverflowError,
} from "./pi-embedded-helpers.js";

const log = createSubsystemLogger("agent/claude-sdk");

export async function runSdkAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
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
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: ImageContent[];
  /** 交互恢复（SDK 模式暂不支持，dispatch 层已拦截） */
  toolResult?: CliToolResultInput;
}): Promise<CliAgentRunResult> {
  const started = Date.now();

  // ── 共享准备逻辑（workspace、backend、system prompt 等） ──
  const prep = await prepareAgentRun({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    config: params.config,
    provider: params.provider,
    model: params.model,
    thinkLevel: params.thinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    runId: params.runId,
    logSubsystem: "agent/claude-sdk",
  });

  const { workspaceDir, modelId, normalizedModel, systemPrompt } = prep;

  // ── 图片处理 ──
  let prompt = params.prompt;
  let cleanupImages: (() => Promise<void>) | undefined;
  if (params.images && params.images.length > 0) {
    const imagePayload = await writeCliImages(params.images);
    cleanupImages = imagePayload.cleanup;
    // SDK 模式通过文件路径引用图片，CC 会用 Read 工具读取
    prompt = appendImagePathsToPrompt(prompt, imagePayload.paths);
  }

  // ── 创建进程内 MCP server ──
  const mcpServer = params.sessionKey
    ? createOcSdkMcpServer({ sessionKey: params.sessionKey })
    : undefined;

  // ── session-writer: 通过 hook 收集工具事件 ──
  const toolUses: CliToolUseEvent[] = [];
  const toolResults: CliToolResultEvent[] = [];

  const postToolUseHook: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") {
      toolUses.push({
        id: input.tool_use_id,
        name: input.tool_name,
        input: isRecord(input.tool_input) ? input.tool_input : {},
      });
      toolResults.push({
        toolUseId: input.tool_use_id,
        content:
          typeof input.tool_response === "string"
            ? input.tool_response
            : JSON.stringify(input.tool_response),
        isError: false,
      });
    }
    return { continue: true };
  };

  const postToolUseFailureHook: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUseFailure") {
      toolResults.push({
        toolUseId: input.tool_use_id,
        content: input.error,
        isError: true,
      });
    }
    return { continue: true };
  };

  // ── 超时控制 ──
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, params.timeoutMs);

  try {
    log.info(
      `sdk exec: provider=${params.provider} model=${normalizedModel} promptChars=${prompt.length}` +
        (params.cliSessionId ? ` resume=${params.cliSessionId.slice(0, 8)}` : ""),
    );

    const sdkQuery = query({
      prompt,
      options: {
        cwd: workspaceDir,
        model: normalizedModel !== "default" ? normalizedModel : undefined,
        resume: params.cliSessionId ?? undefined,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPrompt,
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: mcpServer ? { openclaw: mcpServer } : undefined,
        abortController,
        settingSources: ["project"],
        hooks: {
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseFailureHook] }],
        },
      },
    });

    // ── 迭代 AsyncGenerator 收集结果 ──
    let resultText = "";
    let sessionId: string | undefined;
    let usage: { input?: number; output?: number } | undefined;
    let isError = false;

    // interaction 检测：跟踪最后一个未完成的 AskUserQuestion/ExitPlanMode
    let pendingInteraction: DetectedInteraction | undefined;

    for await (const message of sdkQuery) {
      if ("session_id" in message && message.session_id) {
        sessionId = message.session_id;
      }

      // 从 assistant 消息中检测 AskUserQuestion / ExitPlanMode
      if (message.type === "assistant" && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block.type !== "tool_use") {
            continue;
          }
          const detected = detectInteractionFromToolUse(block.id, block.name, block.input);
          if (detected) {
            pendingInteraction = detected;
          }
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          resultText = message.result;
        } else {
          isError = true;
          resultText = message.errors?.join("\n") ?? `SDK error: ${message.subtype}`;
        }
        usage = {
          input: message.usage?.input_tokens,
          output: message.usage?.output_tokens,
        };
      }
    }

    // 如果 AskUserQuestion 的 tool_use_id 已出现在 toolResults 中，说明已完成，不是 pending
    if (pendingInteraction) {
      const answered = toolResults.some((r) => r.toolUseId === pendingInteraction!.toolCallId);
      if (answered) {
        pendingInteraction = undefined;
      }
    }

    // ── session-writer: 将工具事件写入记忆索引 ──
    if (params.sessionFile && (toolUses.length > 0 || toolResults.length > 0)) {
      await writeCliEventsToSession({
        sessionFile: params.sessionFile,
        sessionId: sessionId ?? params.sessionId,
        cwd: workspaceDir,
        events: {
          text: resultText,
          sessionId,
          usage,
          toolUses,
          toolResults,
        },
        provider: params.provider,
        model: modelId,
      });
    }

    // ── 错误处理 ──
    if (isError) {
      if (isLikelyContextOverflowError(resultText)) {
        log.warn(
          `[sdk-context-overflow] provider=${params.provider}/${modelId} err=${resultText.slice(0, 200)}`,
        );
        throw new Error(`context overflow: ${resultText}`);
      }
      const reason = classifyFailoverReason(resultText) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(resultText, {
        reason,
        provider: params.provider,
        model: modelId,
        status,
      });
    }

    // ── 构建返回值 ──
    const text = resultText.trim();
    const payloads = text ? [{ text }] : undefined;

    log.info(
      `sdk done: provider=${params.provider} model=${normalizedModel} ` +
        `duration=${Date.now() - started}ms textChars=${text.length} ` +
        `tools=${toolUses.length} session=${sessionId?.slice(0, 8) ?? "none"}` +
        (pendingInteraction ? ` interaction=${pendingInteraction.type}` : ""),
    );

    return {
      payloads,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: sessionId ?? params.sessionId ?? "",
          provider: params.provider,
          model: modelId,
          usage,
        },
      },
      pendingInteraction,
    };
  } catch (err) {
    if (err instanceof FailoverError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);

    if (abortController.signal.aborted) {
      const reason = classifyFailoverReason("timeout") ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(`SDK agent timed out after ${params.timeoutMs}ms`, {
        reason,
        provider: params.provider,
        model: modelId,
        status,
      });
    }

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
    clearTimeout(timeoutId);
    if (cleanupImages) {
      await cleanupImages();
    }
  }
}

/**
 * 从工具调用中检测交互请求（AskUserQuestion / ExitPlanMode）
 */
function detectInteractionFromToolUse(
  toolCallId: string,
  toolName: string,
  toolInput: unknown,
): DetectedInteraction | undefined {
  if (toolName === "AskUserQuestion") {
    const input = isRecord(toolInput) ? toolInput : {};
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const firstQuestion = questions[0];
    if (firstQuestion && isRecord(firstQuestion)) {
      const question = typeof firstQuestion.question === "string" ? firstQuestion.question : "";
      const multiSelect = Boolean(firstQuestion.multiSelect);
      const rawOptions = Array.isArray(firstQuestion.options) ? firstQuestion.options : [];
      const options: InteractionOption[] = rawOptions
        .filter((opt): opt is Record<string, unknown> => isRecord(opt))
        .map((opt) => ({
          label: typeof opt.label === "string" ? opt.label : "",
          description: typeof opt.description === "string" ? opt.description : undefined,
        }))
        .filter((opt) => opt.label);
      if (question) {
        return {
          type: "ask_user_question",
          toolCallId,
          question,
          options: options.length > 0 ? options : undefined,
          multiSelect,
        };
      }
    }
  }

  if (toolName === "ExitPlanMode") {
    return {
      type: "plan_approval",
      toolCallId,
      question: "AI 已完成计划制定，是否批准执行？",
    };
  }

  return undefined;
}
