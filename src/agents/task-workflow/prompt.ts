/**
 * 生成工作流的 system prompt 段落
 *
 * 在 buildSubagentSystemPrompt() 中调用，
 * 当 workflow 存在时追加任务列表指令到 extraSystemPrompt。
 */

import type { TaskWorkflow } from "./types.js";

/**
 * 生成工作流任务列表的 system prompt 段落
 */
export function buildWorkflowPromptSection(workflow: TaskWorkflow): string {
  const lines: string[] = [
    "## 结构化任务工作流",
    "",
    `工作流: ${workflow.title} (${workflow.workflowId})`,
    "",
    "### 任务列表",
    "",
  ];

  for (const task of workflow.tasks) {
    const deps = task.dependsOn?.length ? ` (依赖: ${task.dependsOn.join(", ")})` : "";
    const statusIcon =
      task.status === "completed"
        ? "[x]"
        : task.status === "in_progress"
          ? "[>]"
          : task.status === "skipped"
            ? "[-]"
            : "[ ]";
    lines.push(`- ${statusIcon} **${task.id}**: ${task.subject}${deps}`);
    if (task.description) {
      lines.push(`  ${task.description}`);
    }
    if (task.progressNote) {
      lines.push(`  进度: ${task.progressNote}`);
    }
  }

  lines.push(
    "",
    "### 执行规则",
    "",
    "1. **按顺序执行**: 从第一个 pending 任务开始，尊重 dependsOn 依赖关系",
    '2. **状态报告**: 每个任务开始时调用 `oc_task_update(taskId, "in_progress")`，完成时调用 `oc_task_update(taskId, "completed", note?)`',
    '3. **Review 任务**: 如果任务标题包含 "review"/"检查"/"审查"，应仔细检查自己之前的代码改动。发现问题时先修复，然后再标记为 completed',
    "4. **循环修复**: Review 发现问题 → 修复 → 重新 review，直到满意后才标记 completed",
    '5. **全部完成后**: 输出 SUMMARY，包含工作流进度摘要（如 "6/6 tasks done"）',
    '6. **跳过任务**: 如果某个任务不适用，调用 `oc_task_update(taskId, "skipped", note)` 说明原因',
    "",
  );

  return lines.join("\n");
}

/**
 * 生成工作流进度摘要（用于 CLAUDE.md 和 announce 通知）
 */
export function buildWorkflowProgressSummary(workflow: TaskWorkflow): string {
  const total = workflow.tasks.length;
  const completed = workflow.tasks.filter((t) => t.status === "completed").length;
  const skipped = workflow.tasks.filter((t) => t.status === "skipped").length;
  const inProgress = workflow.tasks.filter((t) => t.status === "in_progress").length;
  const done = completed + skipped;

  const lines: string[] = [`工作流 "${workflow.title}" 进度: ${done}/${total}`];

  if (inProgress > 0) {
    const current = workflow.tasks.find((t) => t.status === "in_progress");
    if (current) {
      lines.push(`当前: ${current.id} - ${current.subject}`);
    }
  }

  for (const task of workflow.tasks) {
    if (task.status === "pending") {
      continue;
    }
    const icon = task.status === "completed" ? "done" : task.status === "skipped" ? "skip" : "wip";
    const note = task.progressNote ? ` - ${task.progressNote}` : "";
    lines.push(`  ${task.id} [${icon}] ${task.subject}${note}`);
  }

  return lines.join("\n");
}
