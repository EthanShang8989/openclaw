import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { reserveSubagentSlot, releaseSubagentSlot } from "../subagent-manager.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat alias. Prefer runTimeoutSeconds.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  planMode: Type.Optional(Type.Boolean()),
});

function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const planMode = params.planMode === true;
      // planMode 时强制 cleanup = "keep"（需要保留 session 以便后续 sessions_send 审批）
      const cleanup = planMode
        ? "keep"
        : params.cleanup === "keep" || params.cleanup === "delete"
          ? params.cleanup
          : "keep";
      const requesterOrigin = normalizeDeliveryContext({
        channel: opts?.agentChannel,
        accountId: opts?.agentAccountId,
        to: opts?.agentTo,
        threadId: opts?.agentThreadId,
      });
      const runTimeoutSeconds = (() => {
        const explicit =
          typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
            ? Math.max(0, Math.floor(params.runTimeoutSeconds))
            : undefined;
        if (explicit !== undefined) {
          return explicit;
        }
        const legacy =
          typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
            ? Math.max(0, Math.floor(params.timeoutSeconds))
            : undefined;
        return legacy ?? 0;
      })();
      let modelWarning: string | undefined;
      let modelApplied = false;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
        return jsonResult({
          status: "forbidden",
          error: "sessions_spawn is not allowed from sub-agent sessions",
        });
      }

      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });

      // 原子预留槽位（防止并发超限）
      const reservation = reserveSubagentSlot(requesterInternalKey);
      if (!reservation.allowed) {
        return jsonResult({
          status: "rejected",
          error: reservation.reason,
        });
      }
      const reserveId = reservation.reserveId!;

      // 后续出错时释放预留槽位
      const releaseReservation = () => releaseSubagentSlot(reserveId);

      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;
      if (targetAgentId !== requesterAgentId) {
        const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((value) => value.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((value) => value.trim() && value.trim() !== "*")
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );
        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          releaseReservation();
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
          });
        }
      }
      const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
      const spawnedByKey = requesterInternalKey;
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);

      const resolvedThinkingDefaultRaw =
        readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
        readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

      let thinkingOverride: string | undefined;
      const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
      if (thinkingCandidateRaw) {
        const normalized = normalizeThinkLevel(thinkingCandidateRaw);
        if (!normalized) {
          releaseReservation();
          const { provider, model } = splitModelRef(resolvedModel);
          const hint = formatThinkingLevels(provider, model);
          return jsonResult({
            status: "error",
            error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
          });
        }
        thinkingOverride = normalized;
      }
      if (resolvedModel) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, model: resolvedModel },
            timeoutMs: 10_000,
          });
          modelApplied = true;
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          const recoverable =
            messageText.includes("invalid model") || messageText.includes("model not allowed");
          if (!recoverable) {
            releaseReservation();
            return jsonResult({
              status: "error",
              error: messageText,
              childSessionKey,
            });
          }
          modelWarning = messageText;
        }
      }
      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterOrigin,
        childSessionKey,
        label: label || undefined,
        task,
        planMode,
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            channel: requesterOrigin?.channel,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: childSystemPrompt,
            thinking: thinkingOverride,
            timeout: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
            label: label || undefined,
            spawnedBy: spawnedByKey,
            groupId: opts?.agentGroupId ?? undefined,
            groupChannel: opts?.agentGroupChannel ?? undefined,
            groupSpace: opts?.agentGroupSpace ?? undefined,
          },
          timeoutMs: 10_000,
        });
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
      } catch (err) {
        releaseReservation();
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          status: "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      // 注册成功，将预留槽位转为正式运行状态
      registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        task,
        cleanup,
        label: label || undefined,
        runTimeoutSeconds,
        model: resolvedModel,
        reserveId, // 传入预留 ID，注册时会自动释放
        planMode,
      });

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}
