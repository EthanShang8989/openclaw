/**
 * 工作流状态管理
 *
 * 提供任务更新、进度查询、下一任务获取等功能。
 * 由 subagentManager.updateWorkflowTask() 委托调用。
 */

import type { TaskWorkflow, WorkflowTaskInput, WorkflowTaskStatus } from "./types.js";

/**
 * 从 sessions_spawn 的输入创建 TaskWorkflow 实例
 */
export function createWorkflow(title: string, taskInputs: WorkflowTaskInput[]): TaskWorkflow {
  const now = Date.now();
  return {
    workflowId: `wf-${now}`,
    title,
    tasks: taskInputs.map((input) => ({
      id: input.id,
      subject: input.subject,
      description: input.description,
      status: "pending" as const,
      dependsOn: input.dependsOn,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 更新单个任务状态
 *
 * @returns 错误消息或 undefined（成功）
 */
export function updateTask(
  workflow: TaskWorkflow,
  taskId: string,
  status: WorkflowTaskStatus,
  note?: string,
): string | undefined {
  const task = workflow.tasks.find((t) => t.id === taskId);
  if (!task) {
    return `任务 "${taskId}" 不存在`;
  }

  // 检查依赖是否满足（对于 in_progress 状态）
  if (status === "in_progress" && task.dependsOn?.length) {
    const unmet = task.dependsOn.filter((depId) => {
      const dep = workflow.tasks.find((t) => t.id === depId);
      return dep && dep.status !== "completed" && dep.status !== "skipped";
    });
    if (unmet.length > 0) {
      return `任务 "${taskId}" 的前置任务未完成: ${unmet.join(", ")}`;
    }
  }

  task.status = status;
  if (note) {
    task.progressNote = note;
  }
  if (status === "completed" || status === "skipped") {
    task.completedAt = Date.now();
  }
  workflow.updatedAt = Date.now();
  return undefined;
}

/**
 * 获取进度摘要字符串
 */
export function getProgress(workflow: TaskWorkflow): string {
  const total = workflow.tasks.length;
  const completed = workflow.tasks.filter((t) => t.status === "completed").length;
  const skipped = workflow.tasks.filter((t) => t.status === "skipped").length;
  const inProgress = workflow.tasks.filter((t) => t.status === "in_progress").length;
  const done = completed + skipped;
  const pending = total - done - inProgress;

  const parts = [`${done}/${total} tasks completed`];
  if (inProgress > 0) {
    parts.push(`${inProgress} in progress`);
  }
  if (pending > 0) {
    parts.push(`${pending} pending`);
  }

  return parts.join(", ");
}

/**
 * 获取下一个可执行的任务（所有依赖已完成且状态为 pending）
 */
export function getNextTask(workflow: TaskWorkflow) {
  return workflow.tasks.find((task) => {
    if (task.status !== "pending") {
      return false;
    }
    if (!task.dependsOn?.length) {
      return true;
    }
    return task.dependsOn.every((depId) => {
      const dep = workflow.tasks.find((t) => t.id === depId);
      return dep && (dep.status === "completed" || dep.status === "skipped");
    });
  });
}

/**
 * 检查工作流是否全部完成
 */
export function isWorkflowDone(workflow: TaskWorkflow): boolean {
  return workflow.tasks.every((t) => t.status === "completed" || t.status === "skipped");
}
