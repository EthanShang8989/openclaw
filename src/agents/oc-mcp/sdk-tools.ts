/**
 * 进程内 MCP 工具（SDK 模式）
 *
 * 使用 claude-agent-sdk 的 createSdkMcpServer() + tool() 创建，
 * 运行在 OC Gateway 同一进程中，可以直接访问内存中的
 * subagentManager、memorySearchManager 等。
 *
 * 解决了 Phase B stdio 模式的进程隔离问题。
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type SdkMcpParams = {
  sessionKey: string;
};

/**
 * 创建进程内 MCP server（供 SDK query() 的 mcpServers 选项使用）
 */
export function createOcSdkMcpServer(params: SdkMcpParams): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "openclaw",
    version: "1.0.0",
    tools: [
      createMemorySearchTool(params),
      createSubagentListTool(params),
      createTaskUpdateTool(params),
    ],
  });
}

/**
 * oc_memory_search — 搜索 OC 向量记忆数据库
 */
function createMemorySearchTool(params: SdkMcpParams) {
  return tool(
    "oc_memory_search",
    "搜索 OpenClaw 的向量记忆数据库。可以检索过去的对话记忆、用户笔记、会话摘要等。",
    {
      query: z.string().describe("搜索查询文本（语义搜索）"),
      maxResults: z.number().optional().describe("最大返回结果数（默认 5，最大 20）"),
    },
    async (args) => {
      const query = args.query.trim();
      if (!query) {
        return { content: [{ type: "text" as const, text: "错误：query 参数不能为空" }] };
      }
      const maxResults = Math.min(Math.max(args.maxResults ?? 5, 1), 20);

      try {
        const { getMemorySearchManager } = await import("../../memory/search-manager.js");
        const { loadConfig } = await import("../../config/config.js");

        const cfg = loadConfig();
        const { manager, error } = await getMemorySearchManager({ cfg, agentId: "main" });

        if (!manager) {
          return {
            content: [{ type: "text" as const, text: `记忆搜索不可用: ${error ?? "unknown"}` }],
          };
        }

        const results = await manager.search(query, {
          maxResults,
          sessionKey: params.sessionKey,
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `未找到与 "${query}" 相关的记忆。` }],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)}, source: ${r.source})\n${r.snippet}`,
          )
          .join("\n\n---\n\n");

        return {
          content: [
            { type: "text" as const, text: `找到 ${results.length} 条相关记忆:\n\n${formatted}` },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `记忆搜索失败: ${message}` }] };
      }
    },
  );
}

/**
 * oc_subagent_list — 列出当前会话的 subagent 状态
 *
 * 进程内运行，可以直接访问 subagentManager 单例。
 */
function createSubagentListTool(params: SdkMcpParams) {
  return tool(
    "oc_subagent_list",
    "列出当前会话的所有后台 subagent（运行中 + 已完成）。返回 runId、任务描述、状态、运行时长等信息。",
    {
      filter: z.enum(["all", "running", "completed"]).optional().describe("过滤条件。默认 all。"),
    },
    async (args) => {
      const filter = args.filter ?? "all";

      try {
        const { subagentManager } = await import("../subagent-manager.js");

        const running = subagentManager.getActiveForSession(params.sessionKey);
        const completed = subagentManager.getRecentCompletedForSession(params.sessionKey);
        const lines: string[] = [];
        const now = Date.now();

        if (filter === "all" || filter === "running") {
          if (running.length > 0) {
            lines.push(`## 运行中 (${running.length})`);
            for (const ctx of running) {
              const sec = Math.floor((now - ctx.startedAt) / 1000);
              const label = ctx.label || ctx.task.slice(0, 80);
              const planTag = ctx.planMode ? " [PLAN]" : "";
              lines.push(
                `- runId: ${ctx.runId.slice(0, 8)} | session: ${ctx.childSessionKey}${planTag}`,
              );
              lines.push(`  任务: ${label}`);
              lines.push(`  运行时长: ${sec}s | model: ${ctx.model ?? "default"}`);
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
        lines.push("", "---", `总计: ${stats.running} 运行中, ${stats.completed} 已完成`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `查询 subagent 状态失败: ${message}` }],
        };
      }
    },
  );
}

/**
 * oc_task_update — 更新工作流任务状态
 *
 * Subagent 在执行结构化任务工作流时，通过此工具报告每个任务的开始/完成。
 */
function createTaskUpdateTool(params: SdkMcpParams) {
  return tool(
    "oc_task_update",
    "更新当前工作流中某个任务的状态。在开始一个任务时设为 in_progress，完成时设为 completed，不适用时设为 skipped。",
    {
      taskId: z.string().describe("任务 ID（如 t1, t2）"),
      status: z.enum(["in_progress", "completed", "skipped"]).describe("新状态"),
      note: z.string().optional().describe("进度说明或备注"),
    },
    async (args) => {
      const { taskId, status, note } = args;

      try {
        const { subagentManager } = await import("../subagent-manager.js");
        const { persistSubagentRegistry } = await import("../subagent-registry.js");

        const result = subagentManager.updateWorkflowTask(params.sessionKey, taskId, status, note);

        if (!result.success) {
          return {
            content: [{ type: "text" as const, text: `任务更新失败: ${result.error}` }],
          };
        }

        // 持久化到磁盘
        persistSubagentRegistry();

        return {
          content: [
            {
              type: "text" as const,
              text: `任务 ${taskId} 已更新为 ${status}。${result.progress ?? ""}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `任务更新失败: ${message}` }],
        };
      }
    },
  );
}
