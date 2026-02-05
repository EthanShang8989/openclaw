/**
 * CLI 交互问题格式化
 *
 * 将 Claude CLI 的交互问题格式化为用户友好的消息，
 * 发送到 Telegram 等 channel。
 */

import type { PendingInteraction } from "./interaction-manager.js";

/**
 * 格式化交互问题为用户消息
 */
export function formatInteractionQuestion(interaction: PendingInteraction): string {
  const lines: string[] = [];

  // 标题
  if (interaction.type === "plan_approval") {
    lines.push("**AI 需要你确认执行计划：**");
  } else {
    lines.push("**AI 有个问题想问你：**");
  }
  lines.push("");

  // 问题内容
  lines.push(interaction.question);

  // 选项
  if (interaction.options && interaction.options.length > 0) {
    lines.push("");
    lines.push("**选项：**");
    interaction.options.forEach((opt, i) => {
      let optLine = `${i + 1}. ${opt.label}`;
      if (opt.description) {
        optLine += ` - ${opt.description}`;
      }
      lines.push(optLine);
    });
  }

  // 操作提示
  lines.push("");
  if (interaction.options && interaction.options.length > 0) {
    if (interaction.multiSelect) {
      lines.push("回复选项编号（用逗号分隔多个选项）或直接输入你的答案");
    } else {
      lines.push("回复选项编号或直接输入你的答案");
    }
  } else {
    lines.push("直接回复你的答案");
  }

  // 超时和取消提示
  const remainingMs = interaction.expiresAt - Date.now();
  const remainingMin = Math.ceil(remainingMs / 60000);
  lines.push(`${remainingMin} 分钟内未回复将自动取消`);
  lines.push("发送 /cancel 取消当前问题");

  return lines.join("\n");
}

/**
 * 格式化取消确认消息
 */
export function formatCancelConfirmation(): string {
  return "已取消当前问题，AI 将停止等待回复。";
}

/**
 * 格式化超时消息
 */
export function formatTimeoutMessage(): string {
  return "问题已超时，请重新发送你的请求。";
}

/**
 * 格式化恢复执行消息
 */
export function formatResumeMessage(): string {
  return "收到你的回答，AI 正在继续处理...";
}
