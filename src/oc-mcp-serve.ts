#!/usr/bin/env node
/**
 * OC MCP Server 独立进程入口
 *
 * 被 CC CLI 通过 --mcp-config 以 stdio 模式启动。
 * 用法: node oc-mcp-serve.js --session-key <key>
 */

import { startOcMcpServer } from "./agents/oc-mcp/server.js";

function parseArgs(argv: string[]): { sessionKey: string } {
  const idx = argv.indexOf("--session-key");
  if (idx === -1 || idx + 1 >= argv.length) {
    throw new Error("必须提供 --session-key 参数");
  }
  const sessionKey = argv[idx + 1];
  if (!sessionKey) {
    throw new Error("--session-key 参数值缺失");
  }
  return { sessionKey };
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    await startOcMcpServer({ sessionKey: args.sessionKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`oc-mcp-serve error: ${message}\n`);
    process.exit(1);
  }
}

void main();
