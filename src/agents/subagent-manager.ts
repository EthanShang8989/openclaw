/**
 * SubagentManager - 管理主 agent 的后台 subagent 运行状态
 *
 * 核心功能：
 * 1. 并发限制（最多 MAX_CONCURRENT 个 subagent）
 * 2. 总数上限（运行中 + 已完成 ≤ MAX_RETAINED_SUBAGENTS）
 * 3. 状态查询（用于提示词注入）
 * 4. 完成回调触发（通知主 agent）
 */

import type { SubagentRunOutcome } from "./subagent-announce.js";
import type { SubagentRunRecord } from "./subagent-registry.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";

// 最大并发 subagent 数量
export const MAX_CONCURRENT_SUBAGENTS = 5;

// 运行中 + 已完成 subagent 总数上限
export const MAX_RETAINED_SUBAGENTS = 15;

// 运行中的 subagent 上下文
export type SubagentContext = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  label?: string;
  startedAt: number;
  model?: string;
  planMode?: boolean;
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
  // 完成时间戳
  completedAt: number;
  planMode?: boolean;
  planApproved?: boolean;
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
      this.cleanupExpiredReservations();
    }, 60_000); // 每分钟清理一次
    this.cleanupTimer.unref?.();
  }

  // 清理超时的预留槽位（不再按时间清理已完成记录）
  private cleanupExpiredReservations() {
    const now = Date.now();
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
    if (!key) {
      return 0;
    }
    const runningCount = [...this.running.values()].filter(
      (ctx) => ctx.requesterSessionKey === key,
    ).length;
    const reservedCount = [...this.reserved.values()].filter(
      (info) => info.requesterSessionKey === key,
    ).length;
    return runningCount + reservedCount;
  }

  // 获取指定 session 的总数（运行中 + 已完成 + 预留）
  private getTotalCountForSession(requesterSessionKey: string): number {
    const key = requesterSessionKey.trim();
    if (!key) {
      return 0;
    }
    const runningCount = [...this.running.values()].filter(
      (ctx) => ctx.requesterSessionKey === key,
    ).length;
    const completedCount = [...this.completed.values()].filter(
      (r) => r.requesterSessionKey === key,
    ).length;
    const reservedCount = [...this.reserved.values()].filter(
      (info) => info.requesterSessionKey === key,
    ).length;
    return runningCount + completedCount + reservedCount;
  }

  // 列出指定 session 的可删除 subagent（用于提示主 agent）
  private getSuggestionsForRemoval(requesterSessionKey: string): string[] {
    const key = requesterSessionKey.trim();
    if (!key) {
      return [];
    }
    return [...this.completed.values()]
      .filter((r) => r.requesterSessionKey === key)
      .toSorted((a, b) => a.completedAt - b.completedAt)
      .slice(0, 3)
      .map((r) => r.runId);
  }

  // 原子预留槽位（返回 reserveId 用于后续注册或释放）
  reserveSlot(requesterSessionKey: string): {
    allowed: boolean;
    reserveId?: string;
    reason?: string;
    suggestions?: string[];
  } {
    // 检查并发限制
    const activeCount = this.getActiveCountForSession(requesterSessionKey);
    if (activeCount >= MAX_CONCURRENT_SUBAGENTS) {
      return {
        allowed: false,
        reason: `已达到并发限制：最多 ${MAX_CONCURRENT_SUBAGENTS} 个 subagent`,
      };
    }
    // 检查总数上限
    const totalCount = this.getTotalCountForSession(requesterSessionKey);
    if (totalCount >= MAX_RETAINED_SUBAGENTS) {
      const suggestions = this.getSuggestionsForRemoval(requesterSessionKey);
      return {
        allowed: false,
        reason: `已达到总数上限：最多 ${MAX_RETAINED_SUBAGENTS} 个 subagent（运行中 + 已完成）。请用 sessions_subagent_remove 删除已完成的 subagent 后重试。`,
        suggestions,
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
    const totalCount = this.getTotalCountForSession(requesterSessionKey);
    if (totalCount >= MAX_RETAINED_SUBAGENTS) {
      return {
        allowed: false,
        reason: `已达到总数上限：最多 ${MAX_RETAINED_SUBAGENTS} 个 subagent`,
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
  // 注意：不再通过 enqueueSystemEvent 注入完整回调消息，
  // 改由 announce flow 统一发送精简消息，避免上下文膨胀
  private triggerMainAgentCallback(result: SubagentResult) {
    // 只保留心跳唤醒（让主 agent 感知 subagent 完成）
    requestHeartbeatNow({ reason: "subagent-completed", coalesceMs: 1000 });
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

  // 获取指定 session 的所有已完成 subagent（不再按时间过滤）
  getRecentCompletedForSession(requesterSessionKey: string): SubagentResult[] {
    const key = requesterSessionKey.trim();
    if (!key) {
      return [];
    }
    return [...this.completed.values()]
      .filter((result) => result.requesterSessionKey === key)
      .toSorted((a, b) => b.completedAt - a.completedAt);
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

  // 生成状态文本（用于系统提示词注入）— 显示全部 subagent
  getStatusForPrompt(sessionKey: string): string {
    const active = this.getActiveForSession(sessionKey);
    const completed = this.getRecentCompletedForSession(sessionKey);

    if (active.length === 0 && completed.length === 0) {
      return "";
    }

    const lines: string[] = ["## 后台任务状态"];
    const now = Date.now();
    const total = active.length + completed.length;
    lines.push(`(${total}/${MAX_RETAINED_SUBAGENTS} slots used)`);

    if (active.length > 0) {
      lines.push("");
      lines.push("**运行中:**");
      for (const ctx of active) {
        const duration = formatDuration(now - ctx.startedAt);
        const label = ctx.label || ctx.task.slice(0, 50);
        const planTag = ctx.planMode ? " [PLAN]" : "";
        lines.push(`- \`${ctx.runId.slice(0, 8)}\` [${label}]${planTag} 运行中 (${duration})`);
      }
    }

    if (completed.length > 0) {
      lines.push("");
      lines.push("**已完成:**");
      for (const result of completed) {
        const label = result.label || result.task.slice(0, 50);
        const statusText =
          result.outcome.status === "ok"
            ? "成功"
            : result.outcome.status === "error"
              ? "失败"
              : result.outcome.status;
        const planTag = result.planMode
          ? result.planApproved
            ? " [PLAN:APPROVED]"
            : " [PLAN:AWAITING APPROVAL]"
          : "";
        lines.push(
          `- \`${result.runId.slice(0, 8)}\` [${label}]${planTag} ${statusText} | session: ${result.childSessionKey}`,
        );
      }
    }

    return lines.join("\n");
  }

  // 删除已完成的 subagent（释放槽位）
  removeSubagent(
    runId: string,
    requesterSessionKey: string,
  ): { success: boolean; reason?: string } {
    const key = requesterSessionKey.trim();
    // 检查是否在运行中（不允许删除）
    if (this.running.has(runId)) {
      return {
        success: false,
        reason: "Cannot remove a running subagent. Wait for it to complete first.",
      };
    }
    const result = this.completed.get(runId);
    if (!result) {
      return { success: false, reason: `Subagent "${runId}" not found in completed list.` };
    }
    // 权限检查：只能删除自己 session 下的
    if (result.requesterSessionKey !== key) {
      return {
        success: false,
        reason: "Permission denied: subagent belongs to a different session.",
      };
    }
    this.completed.delete(runId);
    return { success: true };
  }

  // 从 SubagentRunRecord 同步状态
  syncFromRecord(record: SubagentRunRecord) {
    // 如果已结束，标记完成
    if (record.endedAt && record.outcome) {
      if (this.running.has(record.runId)) {
        this.markCompleted({
          runId: record.runId,
          outcome: record.outcome,
          endedAt: record.endedAt,
        });
      } else if (!this.completed.has(record.runId)) {
        // 重启后恢复：将已完成记录同步到 completed map（用于总数上限计算）
        this.completed.set(record.runId, {
          runId: record.runId,
          childSessionKey: record.childSessionKey,
          requesterSessionKey: record.requesterSessionKey,
          task: record.task,
          label: record.label,
          startedAt: record.startedAt ?? record.createdAt,
          endedAt: record.endedAt,
          outcome: record.outcome,
          notified: true, // 重启恢复的记录视为已通知
          completedAt: record.endedAt,
          planMode: record.planMode,
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
        planMode: record.planMode,
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
  suggestions?: string[];
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

// 便捷函数：删除已完成的 subagent
export function removeSubagent(
  runId: string,
  requesterSessionKey: string,
): { success: boolean; reason?: string } {
  return subagentManager.removeSubagent(runId, requesterSessionKey);
}
