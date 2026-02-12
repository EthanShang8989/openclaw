/**
 * MCP 工具注册入口 — 将所有 OC 工具注册到 MCP server
 *
 * 使用统一的 ListTools / CallTool 分发器，
 * 各工具模块只导出定义和 handler 函数。
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OcMcpServerParams } from "../server.js";
import { handleMemorySearch, memorySearchToolDef } from "./memory-search.js";
import {
  handleSubagentList,
  handleSubagentSend,
  subagentListToolDef,
  subagentSendToolDef,
} from "./subagent-status.js";

export type McpToolParams = OcMcpServerParams;

/** 所有工具定义 */
const ALL_TOOL_DEFS = [memorySearchToolDef, subagentListToolDef, subagentSendToolDef];

/** 工具名 → handler 映射 */
type ToolHandler = (
  args: Record<string, unknown>,
  params: McpToolParams,
) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function buildHandlerMap(params: McpToolParams): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set(memorySearchToolDef.name, handleMemorySearch);
  map.set(subagentListToolDef.name, handleSubagentList);
  map.set(subagentSendToolDef.name, handleSubagentSend);
  void params;
  return map;
}

export function registerTools(server: Server, params: McpToolParams): void {
  const handlers = buildHandlerMap(params);

  // ListTools — 返回所有工具定义
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOL_DEFS,
  }));

  // CallTool — 分发到对应 handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const handler = handlers.get(toolName);
    if (!handler) {
      return {
        content: [{ type: "text" as const, text: `未知工具: ${toolName}` }],
        isError: true,
      };
    }
    const args = (request.params.arguments ?? {}) satisfies Record<string, unknown>;
    try {
      return await handler(args, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `工具 ${toolName} 执行失败: ${message}` }],
        isError: true,
      };
    }
  });
}
