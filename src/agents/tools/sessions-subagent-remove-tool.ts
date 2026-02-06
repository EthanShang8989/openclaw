import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { removeSubagent } from "../subagent-manager.js";
import { releaseSubagentRun } from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const Schema = Type.Object({
  runId: Type.String(),
});

export function createSessionsSubagentRemoveTool(opts?: {
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_subagent_remove",
    description:
      "Remove a completed subagent from history to free a slot (max 15). Cannot remove running subagents.",
    parameters: Schema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const runId = readStringParam(params, "runId", { required: true });
      if (!runId) {
        return jsonResult({ status: "error", error: "runId is required" });
      }

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({ key: requesterSessionKey, alias, mainKey })
        : alias;

      // 从 SubagentManager（内存状态）中移除
      const result = removeSubagent(runId, requesterInternalKey);
      if (!result.success) {
        return jsonResult({ status: "error", error: result.reason });
      }

      // 从 SubagentRegistry（持久化）中移除
      releaseSubagentRun(runId);

      return jsonResult({
        status: "ok",
        message: `Subagent "${runId}" removed successfully. Slot freed.`,
      });
    },
  };
}
