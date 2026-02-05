/**
 * CLI 交互状态管理
 *
 * 管理 Claude CLI 的 AskUserQuestion/Plan Mode 等交互状态，
 * 让 CLI 的交互功能能够通过 channel（如 Telegram）与用户交互。
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("cli-interaction");

// 默认超时时间：5 分钟
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// 清理间隔：1 分钟
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * 问题选项
 */
export type InteractionOption = {
  label: string;
  description?: string;
};

/**
 * 待回答的交互状态
 */
export type PendingInteraction = {
  /** 唯一标识 */
  id: string;
  /** CLI 会话 ID（用于 resume） */
  cliSessionId: string;
  /** OpenClaw 会话 Key */
  sessionKey: string;
  /** 工具调用 ID */
  toolCallId: string;
  /** 交互类型 */
  type: "ask_user_question" | "plan_approval";
  /** 问题内容 */
  question: string;
  /** 问题选项 */
  options?: InteractionOption[];
  /** 是否支持多选 */
  multiSelect?: boolean;
  /** 创建时间戳 */
  createdAt: number;
  /** 超时时间戳 */
  expiresAt: number;
  /** Agent ID（未来支持多 agent） */
  agentId?: string;
  /** Provider（如 claude-cli） */
  provider?: string;
};

/**
 * 从 CLI 输出中检测到的交互信息（在 helpers.ts 中使用）
 */
export type DetectedInteraction = {
  type: "ask_user_question" | "plan_approval";
  toolCallId: string;
  question: string;
  options?: InteractionOption[];
  multiSelect?: boolean;
};

// 存储待回答的交互（基于 sessionKey）
const pendingInteractions = new Map<string, PendingInteraction>();

// 清理定时器
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动定期清理（在首次设置交互时自动启动）
 */
function ensureCleanupTimer(): void {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    cleanupExpired();
  }, CLEANUP_INTERVAL_MS);
  // 允许进程退出时不阻塞
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * 停止清理定时器
 */
export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * 设置待回答的交互
 */
export function setPendingInteraction(interaction: PendingInteraction): void {
  ensureCleanupTimer();
  pendingInteractions.set(interaction.sessionKey, interaction);
  log.info(
    `set pending interaction: sessionKey=${interaction.sessionKey} type=${interaction.type} ` +
      `toolCallId=${interaction.toolCallId} expiresIn=${Math.round((interaction.expiresAt - Date.now()) / 1000)}s`,
  );
}

/**
 * 获取待回答的交互
 */
export function getPendingInteraction(sessionKey: string): PendingInteraction | undefined {
  const interaction = pendingInteractions.get(sessionKey);
  if (!interaction) {
    return undefined;
  }
  // 检查是否过期
  if (isExpired(interaction)) {
    log.info(`pending interaction expired: sessionKey=${sessionKey}`);
    pendingInteractions.delete(sessionKey);
    return undefined;
  }
  return interaction;
}

/**
 * 清除待回答的交互
 */
export function clearPendingInteraction(sessionKey: string): boolean {
  const had = pendingInteractions.has(sessionKey);
  pendingInteractions.delete(sessionKey);
  if (had) {
    log.info(`cleared pending interaction: sessionKey=${sessionKey}`);
  }
  return had;
}

/**
 * 检查交互是否已过期
 */
export function isExpired(interaction: PendingInteraction): boolean {
  return Date.now() > interaction.expiresAt;
}

/**
 * 清理所有过期的交互
 */
export function cleanupExpired(): number {
  let cleaned = 0;
  const now = Date.now();
  for (const [sessionKey, interaction] of pendingInteractions) {
    if (now > interaction.expiresAt) {
      pendingInteractions.delete(sessionKey);
      log.info(`cleanup expired interaction: sessionKey=${sessionKey}`);
      cleaned++;
    }
  }
  // 如果没有待处理的交互，停止定时器
  if (pendingInteractions.size === 0) {
    stopCleanupTimer();
  }
  return cleaned;
}

/**
 * 获取所有待处理交互的数量（用于调试）
 */
export function getPendingCount(): number {
  return pendingInteractions.size;
}

/**
 * 创建一个新的 PendingInteraction
 */
export function createPendingInteraction(params: {
  cliSessionId: string;
  sessionKey: string;
  detected: DetectedInteraction;
  provider?: string;
  agentId?: string;
  timeoutMs?: number;
}): PendingInteraction {
  const now = Date.now();
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: crypto.randomUUID(),
    cliSessionId: params.cliSessionId,
    sessionKey: params.sessionKey,
    toolCallId: params.detected.toolCallId,
    type: params.detected.type,
    question: params.detected.question,
    options: params.detected.options,
    multiSelect: params.detected.multiSelect,
    createdAt: now,
    expiresAt: now + timeoutMs,
    provider: params.provider,
    agentId: params.agentId,
  };
}

/**
 * 解析用户回答（支持数字选项和自由文本）
 *
 * @param userMessage 用户输入的消息
 * @param options 可用的选项列表
 * @returns 解析后的回答字符串
 */
export function parseUserAnswer(
  userMessage: string,
  options?: InteractionOption[],
  multiSelect?: boolean,
): string {
  const trimmed = userMessage.trim();

  // 如果没有选项，直接返回用户输入
  if (!options || options.length === 0) {
    return trimmed;
  }

  // 多选支持：解析逗号分隔的编号（如 "1,2,3"）
  if (multiSelect && trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim());
    const labels: string[] = [];
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        const label = options[num - 1]?.label;
        if (label && !labels.includes(label)) {
          labels.push(label);
        }
      }
    }
    if (labels.length > 0) {
      return labels.join(", ");
    }
  }

  // 尝试解析单个数字选项
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    // 用户选择了编号，返回选项的 label
    return options[num - 1]?.label ?? trimmed;
  }

  // 尝试匹配选项 label（不区分大小写）
  const lowerTrimmed = trimmed.toLowerCase();
  for (const opt of options) {
    if (opt.label.toLowerCase() === lowerTrimmed) {
      return opt.label;
    }
  }

  // 无法匹配，返回原始输入（作为自定义回答）
  return trimmed;
}
