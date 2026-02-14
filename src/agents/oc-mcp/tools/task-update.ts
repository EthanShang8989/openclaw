/**
 * MCP 工具：oc_task_update — 更新工作流任务状态
 *
 * Subagent 在执行结构化任务工作流时，通过此工具报告每个任务的开始/完成。
 * stdio 模式版本（与 sdk-tools.ts 中的 SDK 版本对应）。
 */

import type { McpToolParams } from "./index.js";

/** oc_task_update 工具定义 */
export const taskUpdateToolDef = {
  name: "oc_task_update",
  description:
    "更新当前工作流中某个任务的状态。" +
    "在开始一个任务时设为 in_progress，完成时设为 completed，不适用时设为 skipped。",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        description: "任务 ID（如 t1, t2）",
      },
      status: {
        type: "string",
        enum: ["in_progress", "completed", "skipped"],
        description: "新状态",
      },
      note: {
        type: "string",
        description: "进度说明或备注（可选）",
      },
    },
    required: ["taskId", "status"],
  },
};

/**
 * 执行工作流任务状态更新
 */
export async function handleTaskUpdate(
  args: Record<string, unknown>,
  params: McpToolParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
  const status = typeof args.status === "string" ? args.status.trim() : "";
  const note = typeof args.note === "string" ? args.note.trim() : undefined;

  if (!taskId || !status) {
    return {
      content: [{ type: "text", text: "错误：taskId 和 status 参数不能为空" }],
    };
  }

  if (status !== "in_progress" && status !== "completed" && status !== "skipped") {
    return {
      content: [
        { type: "text", text: `错误：无效的状态 "${status}"，需为 in_progress/completed/skipped` },
      ],
    };
  }

  try {
    const { subagentManager } = await import("../../subagent-manager.js");
    const { persistSubagentRegistry } = await import("../../subagent-registry.js");

    const result = subagentManager.updateWorkflowTask(params.sessionKey, taskId, status, note);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `任务更新失败: ${result.error}` }],
      };
    }

    // 持久化到磁盘
    persistSubagentRegistry();

    return {
      content: [
        {
          type: "text",
          text: `任务 ${taskId} 已更新为 ${status}。${result.progress ?? ""}`,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `任务更新失败: ${message}` }],
    };
  }
}
