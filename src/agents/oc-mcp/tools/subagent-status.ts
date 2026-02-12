/**
 * MCP 工具：subagent 状态查询和控制
 *
 * - oc_subagent_list: 列出活跃和已完成的 subagent
 * - oc_subagent_send: 向指定 subagent session 发送消息（预留，后续实现）
 *
 * 替代 Phase 5 的 CLAUDE.md 只读注入，变为双向交互。
 */

import type { McpToolParams } from "./index.js";

/** oc_subagent_list 工具定义 */
export const subagentListToolDef = {
  name: "oc_subagent_list",
  description:
    "列出当前会话的所有后台 subagent（运行中 + 已完成）。" +
    "返回 runId、任务描述、状态、运行时长等信息。",
  inputSchema: {
    type: "object" as const,
    properties: {
      filter: {
        type: "string",
        enum: ["all", "running", "completed"],
        description: "过滤条件：all（全部）、running（运行中）、completed（已完成）。默认 all。",
      },
    },
    required: [],
  },
};

/** oc_subagent_send 工具定义（预留） */
export const subagentSendToolDef = {
  name: "oc_subagent_send",
  description: "向指定的 subagent 会话发送消息。可以用于传递指令、提供额外上下文等。",
  inputSchema: {
    type: "object" as const,
    properties: {
      runId: {
        type: "string",
        description: "目标 subagent 的 runId（前 8 位即可）",
      },
      message: {
        type: "string",
        description: "要发送的消息内容",
      },
    },
    required: ["runId", "message"],
  },
};

/**
 * 执行 subagent 列表查询
 */
export async function handleSubagentList(
  args: Record<string, unknown>,
  params: McpToolParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const filter = typeof args.filter === "string" ? args.filter : "all";

  try {
    const { subagentManager } = await import("../../subagent-manager.js");

    const running = subagentManager.getActiveForSession(params.sessionKey);
    const completed = subagentManager.getRecentCompletedForSession(params.sessionKey);

    const lines: string[] = [];
    const now = Date.now();

    if (filter === "all" || filter === "running") {
      if (running.length > 0) {
        lines.push(`## 运行中 (${running.length})`);
        for (const ctx of running) {
          const durationMs = now - ctx.startedAt;
          const durationSec = Math.floor(durationMs / 1000);
          const label = ctx.label || ctx.task.slice(0, 80);
          const planTag = ctx.planMode ? " [PLAN]" : "";
          lines.push(
            `- runId: ${ctx.runId.slice(0, 8)} | session: ${ctx.childSessionKey}${planTag}`,
          );
          lines.push(`  任务: ${label}`);
          lines.push(`  运行时长: ${durationSec}s | model: ${ctx.model ?? "default"}`);
        }
      } else if (filter === "running") {
        lines.push("没有正在运行的 subagent。");
      }
    }

    if (filter === "all" || filter === "completed") {
      if (completed.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(`## 已完成 (${completed.length})`);
        for (const result of completed) {
          const label = result.label || result.task.slice(0, 80);
          const status =
            result.outcome.status === "ok"
              ? "成功"
              : result.outcome.status === "error"
                ? "失败"
                : result.outcome.status;
          const planTag = result.planMode
            ? result.planApproved
              ? " [PLAN:APPROVED]"
              : " [PLAN:AWAITING]"
            : "";
          lines.push(
            `- runId: ${result.runId.slice(0, 8)} | session: ${result.childSessionKey}${planTag}`,
          );
          lines.push(`  任务: ${label}`);
          lines.push(`  状态: ${status}`);
          if (result.summary) {
            lines.push(`  摘要: ${result.summary.slice(0, 200)}`);
          }
        }
      } else if (filter === "completed") {
        lines.push("没有已完成的 subagent。");
      }
    }

    if (lines.length === 0) {
      lines.push("当前没有任何 subagent。");
    }

    const stats = subagentManager.getStats();
    lines.push("");
    lines.push(`---`);
    lines.push(`总计: ${stats.running} 运行中, ${stats.completed} 已完成`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `查询 subagent 状态失败: ${message}` }],
    };
  }
}

/**
 * 执行 subagent 消息发送（预留实现）
 */
export async function handleSubagentSend(
  args: Record<string, unknown>,
  _params: McpToolParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";

  if (!runId || !message) {
    return {
      content: [{ type: "text", text: "错误：runId 和 message 参数不能为空" }],
    };
  }

  // 预留：后续实现通过 session 系统向 subagent 发送消息
  return {
    content: [
      {
        type: "text",
        text: `oc_subagent_send 功能尚在开发中。目标 subagent: ${runId}, 消息长度: ${message.length} 字符。`,
      },
    ],
  };
}
