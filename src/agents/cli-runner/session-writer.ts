import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import type { CliStreamJsonlOutput } from "./helpers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

const log = createSubsystemLogger("agent/cli-session-writer");

/**
 * 确保会话文件头存在（如果文件不存在则创建）。
 */
async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
}

/**
 * 将 CLI 工具调用事件写入会话文件。
 * 这允许记忆系统索引 CLI 模式下的工具调用和结果。
 */
export async function writeCliEventsToSession(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  events: CliStreamJsonlOutput;
  provider: string;
  model: string;
}): Promise<void> {
  const { sessionFile, sessionId, cwd, events, provider, model } = params;

  // 如果没有工具调用，则不写入事件（只有文本回复由正常流程处理）
  if (events.toolUses.length === 0 && events.toolResults.length === 0) {
    log.debug("no tool events to write");
    return;
  }

  try {
    await ensureSessionHeader({ sessionFile, sessionId, cwd });
    const sessionManager = SessionManager.open(sessionFile);
    const timestamp = Date.now();

    // 构建工具调用到工具名称的映射（用于工具结果）
    const toolIdToName = new Map<string, string>();
    for (const toolUse of events.toolUses) {
      toolIdToName.set(toolUse.id, toolUse.name);
    }

    // 构建助手消息内容（包含工具调用）
    const assistantContent: Array<
      | { type: "text"; text: string }
      | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    > = [];

    // 添加工具调用（使用 "toolCall" 类型和 "arguments" 字段）
    for (const toolUse of events.toolUses) {
      assistantContent.push({
        type: "toolCall",
        id: toolUse.id,
        name: toolUse.name,
        arguments: toolUse.input,
      });
    }

    // 如果有文本回复，也添加到助手消息中
    if (events.text) {
      assistantContent.push({ type: "text", text: events.text });
    }

    // 只有在有内容时才写入助手消息
    if (assistantContent.length > 0) {
      const hasToolCalls = events.toolUses.length > 0;
      // 使用 as never 绕过严格的类型检查（SessionManager 内部支持更多消息类型）
      sessionManager.appendMessage({
        role: "assistant",
        content: assistantContent,
        api: "anthropic-messages",
        provider,
        model,
        usage: {
          input: events.usage?.input ?? 0,
          output: events.usage?.output ?? 0,
          cacheRead: events.usage?.cacheRead ?? 0,
          cacheWrite: events.usage?.cacheWrite ?? 0,
          totalTokens: events.usage?.total ?? 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: hasToolCalls ? "toolUse" : "stop",
        timestamp,
      } as never);
    }

    // 为每个工具结果添加 toolResult 消息
    for (const toolResult of events.toolResults) {
      const toolName = toolIdToName.get(toolResult.toolUseId) ?? "unknown";
      sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: toolResult.toolUseId,
        toolName,
        content: [{ type: "text", text: toolResult.content }],
        isError: toolResult.isError,
        timestamp: timestamp + 1,
      } as never);
    }

    // 触发会话更新事件（用于记忆系统索引）
    emitSessionTranscriptUpdate(sessionFile);
    log.debug(
      `wrote ${events.toolUses.length} tool uses and ${events.toolResults.length} tool results to session`,
    );
  } catch (err) {
    log.warn(
      `failed to write CLI events to session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
