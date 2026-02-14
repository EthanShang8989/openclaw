/**
 * 结构化任务工作流类型定义
 *
 * 支持主 agent 向 subagent 注入任务列表，
 * subagent 自主按顺序执行并通过 MCP 工具报告进度。
 */

export type WorkflowTaskStatus = "pending" | "in_progress" | "completed" | "skipped";

export type WorkflowTask = {
  id: string; // "t1", "t2", ...
  subject: string; // 任务标题
  description?: string; // 详细描述
  status: WorkflowTaskStatus;
  dependsOn?: string[]; // 前置任务 ID
  progressNote?: string; // MCP 工具更新的进度说明
  completedAt?: number; // 完成时间戳（ms）
};

export type TaskWorkflow = {
  workflowId: string;
  title: string;
  tasks: WorkflowTask[];
  createdAt: number;
  updatedAt: number;
};

/**
 * sessions_spawn 中传入的工作流任务定义（简化版，不含运行时状态）
 */
export type WorkflowTaskInput = {
  id: string;
  subject: string;
  description?: string;
  dependsOn?: string[];
};
