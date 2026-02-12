/**
 * OC MCP Server — 向 CC CLI 暴露 OpenClaw 内部工具
 *
 * CC CLI 通过 --mcp-config 连接此 server，
 * 从而可以调用 OC 的记忆搜索、subagent 状态查询等工具。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";

export type OcMcpServerParams = {
  /** 当前会话 key（用于查询 subagent 等） */
  sessionKey: string;
};

/**
 * 创建 OC MCP server 实例（不启动传输层）
 */
export function createOcMcpServer(params: OcMcpServerParams): Server {
  const server = new Server(
    { name: "openclaw", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, params);
  return server;
}

/**
 * 独立进程入口：创建 server 并通过 stdio 传输
 */
export async function startOcMcpServer(params: OcMcpServerParams): Promise<void> {
  const server = createOcMcpServer(params);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
