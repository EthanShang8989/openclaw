/**
 * SubagentManager - 管理主 agent 的后台 subagent 运行状态
 *
 * 核心功能：
 * 1. 并发限制（最多 MAX_CONCURRENT 个 subagent）
 * 2. 状态查询（用于提示词注入）
 * 3. 完成回调触发（通知主 agent）
 */

import type { SubagentRunRecord } from "./subagent-registry.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { emitAgentEvent } from "../infra/agent-events.js";

// 最大并发 subagent 数量
export const MAX_CONCURRENT_SUBAGENTS = 5;

// 已完成 subagent 保留时间（用于状态注入）
const COMPLETED_RETENTION_MS = 5 * 60 * 1000; // 5 分钟

// 运行中的 subagent 上下文
export type SubagentContext = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  label?: string;
  startedAt: number;
  model?: string;
};

// 已完成的 subagent 结果
export type SubagentResult = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  label?: string;
  startedAt: number;
  endedAt: number;
  outcome: SubagentRunOutcome;
  summary?: string;
  // 是否已通知主 agent
  notified: boolean;
  // 完成时间戳（用于清理）
  completedAt: number;
};

// 格式化时长
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}分${remainingSeconds}秒` : `${minutes}分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}小时${remainingMinutes}分钟`;
}

class SubagentManager {
  private running = new Map<string, SubagentContext>();
  private completed = new Map<string, SubagentResult>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  // 预留槽位（用于原子并发控制）
  private reserved = new Map<string, { requesterSessionKey: string; reservedAt: number }>();

  constructor() {
    this.startCleanupTimer();
  }

  // 启动清理定时器
  private startCleanupTimer() {
    if (this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldCompleted();
    }, 60_000); // 每分钟清理一次
    this.cleanupTimer.unref?.();
  }

  // 清理过期的已完成记录和超时的预留
  private cleanupOldCompleted() {
    const now = Date.now();
    for (const [runId, result] of this.completed.entries()) {
      if (now - result.completedAt > COMPLETED_RETENTION_MS) {
        this.completed.delete(runId);
      }
    }
    // 清理超时的预留槽位（30秒未注册则释放）
    for (const [reserveId, info] of this.reserved.entries()) {
      if (now - info.reservedAt > 30_000) {
        this.reserved.delete(reserveId);
      }
    }
  }

  // 获取指定 session 的活跃数量（包括预留槽位）
  private getActiveCountForSession(requesterSessionKey: string): number {
    const key = requesterSessionKey.trim();
    if (!key) return 0;
    const runningCount = [...this.running.values()].filter(
      (ctx) => ctx.requesterSessionKey === key,
    ).length;
    const reservedCount = [...this.reserved.values()].filter(
      (info) => info.requesterSessionKey === key,
    ).length;
    return runningCount + reservedCount;
  }

  // 原子预留槽位（返回 reserveId 用于后续注册或释放）
  reserveSlot(requesterSessionKey: string): { allowed: boolean; reserveId?: string; reason?: string } {
    const activeCount = this.getActiveCountForSession(requesterSessionKey);
    if (activeCount >= MAX_CONCURRENT_SUBAGENTS) {
      return {
        allowed: false,
        reason: `已达到并发限制：最多 ${MAX_CONCURRENT_SUBAGENTS} 个 subagent`,
      };
    }
    const reserveId = crypto.randomUUID();
    this.reserved.set(reserveId, {
      requesterSessionKey: requesterSessionKey.trim(),
      reservedAt: Date.now(),
    });
    return { allowed: true, reserveId };
  }

  // 释放预留槽位（注册失败时调用）
  releaseSlot(reserveId: string) {
    this.reserved.delete(reserveId);
  }

  // 检查并发限制（保留向后兼容，但推荐使用 reserveSlot）
  canSpawn(requesterSessionKey: string): { allowed: boolean; reason?: string } {
    const activeCount = this.getActiveCountForSession(requesterSessionKey);
    if (activeCount >= MAX_CONCURRENT_SUBAGENTS) {
      return {
        allowed: false,
        reason: `已达到并发限制：最多 ${MAX_CONCURRENT_SUBAGENTS} 个 subagent`,
      };
    }
    return { allowed: true };
  }

  // 注册新的 subagent（会自动释放对应的预留槽位）
  register(context: SubagentContext, reserveId?: string) {
    // 释放预留槽位
    if (reserveId) {
      this.reserved.delete(reserveId);
    }
    this.running.set(context.runId, context);

    // 发射事件
    emitAgentEvent({
      runId: context.runId,
      stream: "subagent",
      data: {
        type: "spawned",
        childSessionKey: context.childSessionKey,
        requesterSessionKey: context.requesterSessionKey,
        task: context.task,
        label: context.label,
      },
    });
  }

  // 标记 subagent 完成
  markCompleted(params: {
    runId: string;
    outcome: SubagentRunOutcome;
    summary?: string;
    endedAt?: number;
  }) {
    const context = this.running.get(params.runId);
    if (!context) {
      return;
    }

    const endedAt = params.endedAt ?? Date.now();
    const result: SubagentResult = {
      ...context,
      endedAt,
      outcome: params.outcome,
      summary: params.summary,
      notified: false,
      completedAt: Date.now(),
    };

    this.running.delete(params.runId);
    this.completed.set(params.runId, result);

    // 发射完成事件
    emitAgentEvent({
      runId: params.runId,
      stream: "subagent",
      data: {
        type: "completed",
        childSessionKey: context.childSessionKey,
        requesterSessionKey: context.requesterSessionKey,
        task: context.task,
        label: context.label,
        outcome: params.outcome,
        summary: params.summary,
        durationMs: endedAt - context.startedAt,
      },
    });

    // 触发主 agent 回调
    this.triggerMainAgentCallback(result);
  }

  // 触发主 agent 回调
  private triggerMainAgentCallback(result: SubagentResult) {
    const taskLabel = result.label || result.task;
    const statusText =
      result.outcome.status === "ok"
        ? "成功完成"
        : result.outcome.status === "error"
          ? `失败: ${result.outcome.error || "未知错误"}`
          : result.outcome.status === "timeout"
            ? "超时"
            : "完成";

    const durationText = formatDuration(result.endedAt - result.startedAt);

    // 构造回调消息
    const callbackText = [
      `[后台任务完成] "${taskLabel}" ${statusText} (耗时 ${durationText})`,
      result.summary ? `结果摘要: ${result.summary}` : null,
      "请决定如何处理这个结果。",
    ]
      .filter(Boolean)
      .join("\n");

    // 注入到系统事件队列
    enqueueSystemEvent(callbackText, {
      sessionKey: result.requesterSessionKey,
      contextKey: `subagent-${result.runId}`,
    });

    // 唤醒心跳以触发主 agent
    requestHeartbeatNow({ reason: "subagent-completed", coalesceMs: 1000 });

    // 标记已通知
    result.notified = true;
  }

  // 获取指定 session 的活跃 subagent
  getActiveForSession(requesterSessionKey: string): SubagentContext[] {
    const key = requesterSessionKey.trim();
    if (!key) {
      return [];
    }
    return [...this.running.values()].filter((ctx) => ctx.requesterSessionKey === key);
  }

  // 获取指定 session 的最近完成的 subagent
  getRecentCompletedForSession(requesterSessionKey: string): SubagentResult[] {
    const key = requesterSessionKey.trim();
    if (!key) {
      return [];
    }
    const now = Date.now();
    return [...this.completed.values()]
      .filter(
        (result) =>
          result.requesterSessionKey === key && now - result.completedAt < COMPLETED_RETENTION_MS,
      )
      .sort((a, b) => b.completedAt - a.completedAt);
  }

  // 获取指定 session 的待处理完成通知
  getPendingNotifications(requesterSessionKey: string): SubagentResult[] {
    const key = requesterSessionKey.trim();
    if (!key) {
      return [];
    }
    return [...this.completed.values()].filter(
      (result) => result.requesterSessionKey === key && !result.notified,
    );
  }

  // 生成状态文本（用于系统提示词注入）
  getStatusForPrompt(sessionKey: string): string {
    const active = this.getActiveForSession(sessionKey);
    const recent = this.getRecentCompletedForSession(sessionKey);

    if (active.length === 0 && recent.length === 0) {
      return "";
    }

    const lines: string[] = ["## 后台任务状态"];
    const now = Date.now();

    if (active.length > 0) {
      lines.push("");
      lines.push("**运行中:**");
      for (const ctx of active) {
        const duration = formatDuration(now - ctx.startedAt);
        const label = ctx.label || ctx.task.slice(0, 50);
        lines.push(`- [${label}] 运行中 (${duration})`);
      }
    }

    // 只显示未通知的完成任务
    const unnotified = recent.filter((r) => !r.notified);
    if (unnotified.length > 0) {
      lines.push("");
      lines.push("**刚完成（待处理）:**");
      for (const result of unnotified.slice(0, 5)) {
        const label = result.label || result.task.slice(0, 50);
        const statusText =
          result.outcome.status === "ok"
            ? "成功"
            : result.outcome.status === "error"
              ? "失败"
              : result.outcome.status;
        lines.push(`- [${label}] ${statusText}: ${result.summary || "(无摘要)"}`);
      }
    }

    return lines.join("\n");
  }

  // 从 SubagentRunRecord 同步状态
  syncFromRecord(record: SubagentRunRecord) {
    // 如果已结束，标记完成
    if (record.endedAt && record.outcome) {
      if (!this.completed.has(record.runId) && !this.running.has(record.runId)) {
        // 已经完成但不在我们的记录中，可能是重启后恢复的
        return;
      }
      if (this.running.has(record.runId)) {
        this.markCompleted({
          runId: record.runId,
          outcome: record.outcome,
          endedAt: record.endedAt,
        });
      }
      return;
    }

    // 如果正在运行但不在我们的记录中，添加它
    if (!this.running.has(record.runId) && !this.completed.has(record.runId)) {
      this.register({
        runId: record.runId,
        childSessionKey: record.childSessionKey,
        requesterSessionKey: record.requesterSessionKey,
        task: record.task,
        label: record.label,
        startedAt: record.startedAt ?? record.createdAt,
      });
    }
  }

  // 获取统计信息
  getStats(): { running: number; completed: number; totalActive: number } {
    return {
      running: this.running.size,
      completed: this.completed.size,
      totalActive: this.running.size,
    };
  }

  // 清理所有状态（用于测试）
  resetForTest() {
    this.running.clear();
    this.completed.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// 全局单例
export const subagentManager = new SubagentManager();

// 便捷函数：检查是否可以启动新 subagent
export function canSpawnSubagent(requesterSessionKey: string): {
  allowed: boolean;
  reason?: string;
} {
  return subagentManager.canSpawn(requesterSessionKey);
}

// 便捷函数：原子预留槽位
export function reserveSubagentSlot(requesterSessionKey: string): {
  allowed: boolean;
  reserveId?: string;
  reason?: string;
} {
  return subagentManager.reserveSlot(requesterSessionKey);
}

// 便捷函数：释放预留槽位
export function releaseSubagentSlot(reserveId: string): void {
  subagentManager.releaseSlot(reserveId);
}

// 便捷函数：获取状态文本
export function getSubagentStatusForPrompt(sessionKey: string): string {
  return subagentManager.getStatusForPrompt(sessionKey);
}

// 便捷函数：获取活跃 subagent 列表
export function getActiveSubagentsForSession(sessionKey: string): SubagentContext[] {
  return subagentManager.getActiveForSession(sessionKey);
}

// 便捷函数：获取最近完成的 subagent 列表
export function getRecentCompletedSubagentsForSession(sessionKey: string): SubagentResult[] {
  return subagentManager.getRecentCompletedForSession(sessionKey);
}
