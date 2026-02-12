import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAllCliSessionIds } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";

/**
 * 当 totalTokens >= contextWindow * 85% 时触发 session 轮转。
 * 给 CC 内部 compaction 留 15% 缓冲区。
 */
export const CLI_CONTEXT_ROTATION_RATIO = 0.85;

export function shouldRotateCliSession(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "contextTokens">;
  provider: string;
  model?: string;
  agentCfgContextTokens?: number;
  cfg?: OpenClawConfig;
}): boolean {
  if (!isCliProvider(params.provider, params.cfg)) {
    return false;
  }
  const totalTokens = params.entry?.totalTokens;
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }
  const contextWindow =
    lookupContextTokens(params.model) ??
    params.agentCfgContextTokens ??
    params.entry?.contextTokens ??
    DEFAULT_CONTEXT_TOKENS;
  const threshold = Math.floor(contextWindow * CLI_CONTEXT_ROTATION_RATIO);
  return totalTokens >= threshold;
}

export function prepareCliSessionRotation(entry: SessionEntry): void {
  clearAllCliSessionIds(entry);
  entry.totalTokens = undefined;
  entry.inputTokens = undefined;
  entry.outputTokens = undefined;
}
