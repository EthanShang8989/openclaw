/**
 * MCP 配置生成 — 为 CC CLI 的 --mcp-config 生成临时配置文件
 *
 * 生成的配置指向 OC 内置的 MCP server 入口（oc-mcp-serve.js），
 * CC CLI 启动后通过 stdio 与 MCP server 通信。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agent/oc-mcp");

export type McpConfigResult = {
  /** 生成的配置文件路径 */
  configPath: string;
  /** 清理函数（删除临时文件） */
  cleanup: () => void;
};

/**
 * 解析 MCP server 入口脚本路径
 *
 * 构建产物在 dist/oc-mcp-serve.js，
 * 通过 import.meta.url 相对定位。
 */
function resolveServePath(): string {
  // 运行时（dist）：当前文件在 dist/agents/oc-mcp/config.js
  // 入口在 dist/oc-mcp-serve.js（向上 2 层）
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(currentDir, "../../oc-mcp-serve.js");
}

/**
 * 生成 MCP 配置文件（临时文件），返回路径和清理函数
 */
export async function generateMcpConfig(params: { sessionKey: string }): Promise<McpConfigResult> {
  const configPath = path.join(os.tmpdir(), `oc-mcp-${params.sessionKey}.json`);
  const servePath = resolveServePath();

  const config = {
    mcpServers: {
      openclaw: {
        type: "stdio",
        command: process.execPath, // node
        args: [servePath, "--session-key", params.sessionKey],
      },
    },
  };

  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  log.info(`mcp config written: ${configPath} (serve: ${servePath})`);

  return {
    configPath,
    cleanup: () => {
      try {
        fs.unlinkSync(configPath);
      } catch {
        // 忽略清理失败
      }
    },
  };
}
