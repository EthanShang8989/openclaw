/**
 * MCP 工具：oc_memory_search — 搜索 OC 记忆数据库
 *
 * 让 CC CLI 能主动搜索过去的对话记忆、笔记等，
 * 替代被动的系统提示词注入。
 */

import type { McpToolParams } from "./index.js";

/** 工具定义（供 ListTools 聚合用） */
export const memorySearchToolDef = {
  name: "oc_memory_search",
  description:
    "搜索 OpenClaw 的向量记忆数据库。可以检索过去的对话记忆、用户笔记、会话摘要等。" +
    "用于需要回忆过去信息或上下文时调用。",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "搜索查询文本（语义搜索）",
      },
      maxResults: {
        type: "number",
        description: "最大返回结果数（默认 5，最大 20）",
      },
    },
    required: ["query"],
  },
};

/**
 * 执行记忆搜索（被 CallTool 分发器调用）
 */
export async function handleMemorySearch(
  args: Record<string, unknown>,
  params: McpToolParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return {
      content: [{ type: "text", text: "错误：query 参数不能为空" }],
    };
  }
  const maxResults = Math.min(
    Math.max(typeof args.maxResults === "number" ? Math.floor(args.maxResults) : 5, 1),
    20,
  );

  try {
    // 动态导入避免循环依赖（MCP server 在独立进程中运行时不需要这些模块）
    const { getMemorySearchManager } = await import("../../../memory/search-manager.js");
    const { loadConfig } = await import("../../../config/config.js");

    const cfg = loadConfig();
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    if (!manager) {
      return {
        content: [
          {
            type: "text",
            text: `记忆搜索不可用: ${error ?? "unknown error"}`,
          },
        ],
      };
    }

    const results = await manager.search(query, {
      maxResults,
      sessionKey: params.sessionKey,
    });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `未找到与 "${query}" 相关的记忆。` }],
      };
    }

    const formatted = results
      .map((r, i) => {
        const header = `[${i + 1}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)}, source: ${r.source})`;
        return `${header}\n${r.snippet}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `找到 ${results.length} 条相关记忆:\n\n${formatted}`,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `记忆搜索失败: ${message}` }],
    };
  }
}
