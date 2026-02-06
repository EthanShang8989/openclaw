import crypto from "node:crypto";
import path from "node:path";
import { resolveQueueSettings } from "../auto-reply/reply/queue.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";

function formatDurationShort(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return undefined;
  }
  const totalSeconds = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTokenCount(value?: number) {
  if (!value || !Number.isFinite(value)) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function formatUsd(value?: number) {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

function resolveModelCost(params: {
  provider?: string;
  model?: string;
  config: ReturnType<typeof loadConfig>;
}):
  | {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const models = params.config.models?.providers?.[provider]?.models ?? [];
  const entry = models.find((candidate) => candidate.id === model);
  return entry?.cost;
}

async function waitForSessionUsage(params: { sessionKey: string }) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let entry = loadSessionStore(storePath)[params.sessionKey];
  if (!entry) {
    return { entry, storePath };
  }
  const hasTokens = () =>
    entry &&
    (typeof entry.totalTokens === "number" ||
      typeof entry.inputTokens === "number" ||
      typeof entry.outputTokens === "number");
  if (hasTokens()) {
    return { entry, storePath };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    entry = loadSessionStore(storePath)[params.sessionKey];
    if (hasTokens()) {
      break;
    }
  }
  return { entry, storePath };
}

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  // requesterOrigin (captured at spawn time) reflects the channel the user is
  // actually on and must take priority over the session entry, which may carry
  // stale lastChannel / lastTo values from a previous channel interaction.
  return mergeDeliveryContext(requesterOrigin, deliveryContextFromSession(entry));
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  await callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: origin?.channel,
      accountId: origin?.accountId,
      to: origin?.to,
      threadId,
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
    },
    expectFinal: true,
    timeoutMs: 60_000,
  });
}

function resolveRequesterStoreKey(
  cfg: ReturnType<typeof loadConfig>,
  requesterSessionKey: string,
): string {
  const raw = requesterSessionKey.trim();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return resolveMainSessionKey(cfg);
  }
  const agentId = resolveAgentIdFromSessionKey(raw);
  return `agent:${agentId}:${raw}`;
}

function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = loadConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, entry, canonicalKey };
}

async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  triggerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
}): Promise<"steered" | "queued" | "none"> {
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return "none";
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel,
    sessionEntry: entry,
  });
  const isActive = isEmbeddedPiRunActive(sessionId);

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = queueEmbeddedPiMessage(sessionId, params.triggerMessage);
    if (steered) {
      return "steered";
    }
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    enqueueAnnounce({
      key: canonicalKey,
      item: {
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
      },
      settings: queueSettings,
      send: sendAnnounce,
    });
    return "queued";
  }

  return "none";
}

async function buildSubagentStatsLine(params: {
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}) {
  const cfg = loadConfig();
  const { entry, storePath } = await waitForSessionUsage({
    sessionKey: params.sessionKey,
  });

  const sessionId = entry?.sessionId;
  const transcriptPath =
    sessionId && storePath ? path.join(path.dirname(storePath), `${sessionId}.jsonl`) : undefined;

  const input = entry?.inputTokens;
  const output = entry?.outputTokens;
  const total =
    entry?.totalTokens ??
    (typeof input === "number" && typeof output === "number" ? input + output : undefined);
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const provider = entry?.modelProvider;
  const model = entry?.model;
  const costConfig = resolveModelCost({ provider, model, config: cfg });
  const cost =
    costConfig && typeof input === "number" && typeof output === "number"
      ? (input * costConfig.input + output * costConfig.output) / 1_000_000
      : undefined;

  const parts: string[] = [];
  const runtime = formatDurationShort(runtimeMs);
  parts.push(`runtime ${runtime ?? "n/a"}`);
  if (typeof total === "number") {
    const inputText = typeof input === "number" ? formatTokenCount(input) : "n/a";
    const outputText = typeof output === "number" ? formatTokenCount(output) : "n/a";
    const totalText = formatTokenCount(total);
    parts.push(`tokens ${totalText} (in ${inputText} / out ${outputText})`);
  } else {
    parts.push("tokens n/a");
  }
  const costText = formatUsd(cost);
  if (costText) {
    parts.push(`est ${costText}`);
  }
  parts.push(`sessionKey ${params.sessionKey}`);
  if (sessionId) {
    parts.push(`sessionId ${sessionId}`);
  }
  if (transcriptPath) {
    parts.push(`transcript ${transcriptPath}`);
  }

  return `Stats: ${parts.join(" \u2022 ")}`;
}

export function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  label?: string;
  task?: string;
  planMode?: boolean;
}) {
  const taskText =
    typeof params.task === "string" && params.task.trim()
      ? params.task.replace(/\s+/g, " ").trim()
      : "{{TASK_DESCRIPTION}}";
  const lines = [
    "# Subagent Context",
    "",
    "You are a **subagent** spawned by the main agent for a specific task.",
    "",
    "## Your Role",
    `- You were created to handle: ${taskText}`,
    "- Complete this task. That's your entire purpose.",
    "- You are NOT the main agent. Don't try to be.",
    "",
    "## Rules",
    "1. **Stay focused** - Do your assigned task, nothing else",
    "2. **Complete the task** - Your final message will be automatically reported to the main agent",
    "3. **Don't initiate** - No heartbeats, no proactive actions, no side quests",
    "4. **Be ephemeral** - You may be terminated after task completion. That's fine.",
    "",
    "## Output Format",
    "When complete, structure your output as:",
    "1. Detailed findings (full analysis, code, etc.)",
    "2. ---",
    "3. SUMMARY: A 1-2 sentence summary of what you found/did",
    "The main agent will see your SUMMARY first and use sessions_history to read details if needed.",
    "",
    "## What You DON'T Do",
    "- NO user conversations (that's main agent's job)",
    "- NO external messages (email, tweets, etc.) unless explicitly tasked with a specific recipient/channel",
    "- NO cron jobs or persistent state",
    "- NO pretending to be the main agent",
    "- Only use the `message` tool when explicitly instructed to contact a specific external recipient; otherwise return plain text and let the main agent deliver it",
    "",
  ];

  // Plan Mode 注入
  if (params.planMode) {
    lines.push(
      "## PLAN MODE",
      "You are in PLANNING mode:",
      "1. Research the codebase, understand requirements",
      "2. Write a detailed implementation plan",
      "3. DO NOT implement anything (no file edits/writes)",
      "4. Structure output: detailed plan → --- → SUMMARY: 1-2 sentence summary",
      "5. After approval, you'll continue in this session to implement",
      "",
    );
  }

  lines.push(
    "## Session Context",
    ...[
      params.label ? `- Label: ${params.label}` : undefined,
      params.requesterSessionKey
        ? `- Requester session: ${params.requesterSessionKey}.`
        : undefined,
      params.requesterOrigin?.channel
        ? `- Requester channel: ${params.requesterOrigin.channel}.`
        : undefined,
      `- Your session: ${params.childSessionKey}.`,
    ].filter((line): line is string => line !== undefined),
    "",
  );
  return lines.join("\n");
}

/**
 * 从 subagent 回复中提取摘要。
 * 优先查找 "SUMMARY:" 标记，回退为取最后 maxLen 个字符。
 */
function extractSummary(reply: string | undefined, maxLen: number): string {
  if (!reply) {
    return "(no output)";
  }
  // 优先查找 "SUMMARY:" 标记
  const marker = reply.lastIndexOf("SUMMARY:");
  if (marker >= 0) {
    return reply
      .slice(marker + 8)
      .trim()
      .slice(0, maxLen);
  }
  // 回退：取最后 maxLen 字符
  return reply.length > maxLen ? reply.slice(-maxLen).trim() : reply.trim();
}

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
};

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  planMode?: boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  try {
    const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (!reply && params.waitForCompletion !== false) {
      const waitMs = Math.min(params.timeoutMs, 60_000);
      const wait = await callGateway<{
        status?: string;
        startedAt?: number;
        endedAt?: number;
        error?: string;
      }>({
        method: "agent.wait",
        params: {
          runId: params.childRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      });
      const waitError = typeof wait?.error === "string" ? wait.error : undefined;
      if (wait?.status === "timeout") {
        outcome = { status: "timeout" };
      } else if (wait?.status === "error") {
        outcome = { status: "error", error: waitError };
      } else if (wait?.status === "ok") {
        outcome = { status: "ok" };
      }
      if (typeof wait?.startedAt === "number" && !params.startedAt) {
        params.startedAt = wait.startedAt;
      }
      if (typeof wait?.endedAt === "number" && !params.endedAt) {
        params.endedAt = wait.endedAt;
      }
      if (wait?.status === "timeout") {
        if (!outcome) {
          outcome = { status: "timeout" };
        }
      }
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    if (!reply) {
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    // Build stats
    const statsLine = await buildSubagentStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed successfully"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    // Build compact trigger message for main agent
    // 完整输出留在 subagent 的 session transcript 中，这里只注入精简消息
    const taskLabel = params.label || params.task || "background task";
    const summaryText = extractSummary(reply, 200);

    let triggerMessage: string;
    if (params.planMode && outcome.status === "ok") {
      // Plan Mode 成功完成时发送审批消息
      triggerMessage = [
        `[PLAN READY] "${taskLabel}" plan completed`,
        `session: ${params.childSessionKey}`,
        "",
        `To approve: sessions_send sessionKey="${params.childSessionKey}" message="APPROVED: proceed"`,
        `To reject:  sessions_send sessionKey="${params.childSessionKey}" message="REJECTED: <reason>"`,
        "",
        `Summary: ${summaryText}`,
        "",
        "Need full plan? Use sessions_history to read the subagent's output.",
      ].join("\n");
    } else if (params.planMode) {
      // Plan Mode 失败时，不发送审批指令
      triggerMessage = [
        `[PLAN FAILED] "${taskLabel}" ${statusLabel}`,
        `session: ${params.childSessionKey}`,
        "",
        `Summary: ${summaryText}`,
        "",
        "The plan subagent did not complete successfully. Review sessions_history for details.",
      ].join("\n");
    } else {
      triggerMessage = [
        `[Subagent] "${taskLabel}" ${statusLabel}`,
        `session: ${params.childSessionKey}`,
        "",
        `Summary: ${summaryText}`,
        "",
        statsLine,
        "",
        "Summarize this naturally for the user. Keep it brief (1-2 sentences).",
        "Need details? Use sessions_history to read the full output.",
        "You can respond with NO_REPLY if no announcement is needed.",
      ].join("\n");
    }

    const queued = await maybeQueueSubagentAnnounce({
      requesterSessionKey: params.requesterSessionKey,
      triggerMessage,
      summaryLine: taskLabel,
      requesterOrigin,
    });
    if (queued === "steered") {
      didAnnounce = true;
      return true;
    }
    if (queued === "queued") {
      didAnnounce = true;
      return true;
    }

    // Send to main agent - it will respond in its own voice
    let directOrigin = requesterOrigin;
    if (!directOrigin) {
      const { entry } = loadRequesterSessionEntry(params.requesterSessionKey);
      directOrigin = deliveryContextFromSession(entry);
    }
    await callGateway({
      method: "agent",
      params: {
        sessionKey: params.requesterSessionKey,
        message: triggerMessage,
        deliver: true,
        channel: directOrigin?.channel,
        accountId: directOrigin?.accountId,
        to: directOrigin?.to,
        threadId:
          directOrigin?.threadId != null && directOrigin.threadId !== ""
            ? String(directOrigin.threadId)
            : undefined,
        idempotencyKey: crypto.randomUUID(),
      },
      expectFinal: true,
      timeoutMs: 60_000,
    });

    didAnnounce = true;
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (params.cleanup === "delete") {
      try {
        await callGateway({
          method: "sessions.delete",
          params: { key: params.childSessionKey, deleteTranscript: true },
          timeoutMs: 10_000,
        });
      } catch {
        // ignore
      }
    }
  }
  return didAnnounce;
}
