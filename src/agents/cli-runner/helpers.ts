import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { runExec } from "../../process/exec.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";
import type { DetectedInteraction, InteractionOption } from "./interaction-manager.js";

const CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function cleanupResumeProcesses(
  backend: CliBackendConfig,
  sessionId: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const resumeArgs = backend.resumeArgs ?? [];
  if (resumeArgs.length === 0) {
    return;
  }
  if (!resumeArgs.some((arg) => arg.includes("{sessionId}"))) {
    return;
  }
  const commandToken = path.basename(backend.command ?? "").trim();
  if (!commandToken) {
    return;
  }

  const resumeTokens = resumeArgs.map((arg) => arg.replaceAll("{sessionId}", sessionId));
  const pattern = [commandToken, ...resumeTokens]
    .filter(Boolean)
    .map((token) => escapeRegex(token))
    .join(".*");
  if (!pattern) {
    return;
  }

  try {
    await runExec("pkill", ["-f", pattern]);
  } catch {
    // ignore missing pkill or no matches
  }
}

function buildSessionMatchers(backend: CliBackendConfig): RegExp[] {
  const commandToken = path.basename(backend.command ?? "").trim();
  if (!commandToken) {
    return [];
  }
  const matchers: RegExp[] = [];
  const sessionArg = backend.sessionArg?.trim();
  const sessionArgs = backend.sessionArgs ?? [];
  const resumeArgs = backend.resumeArgs ?? [];

  const addMatcher = (args: string[]) => {
    if (args.length === 0) {
      return;
    }
    const tokens = [commandToken, ...args];
    const pattern = tokens
      .map((token, index) => {
        const tokenPattern = tokenToRegex(token);
        return index === 0 ? `(?:^|\\s)${tokenPattern}` : `\\s+${tokenPattern}`;
      })
      .join("");
    matchers.push(new RegExp(pattern));
  };

  if (sessionArgs.some((arg) => arg.includes("{sessionId}"))) {
    addMatcher(sessionArgs);
  } else if (sessionArg) {
    addMatcher([sessionArg, "{sessionId}"]);
  }

  if (resumeArgs.some((arg) => arg.includes("{sessionId}"))) {
    addMatcher(resumeArgs);
  }

  return matchers;
}

function tokenToRegex(token: string): string {
  if (!token.includes("{sessionId}")) {
    return escapeRegex(token);
  }
  const parts = token.split("{sessionId}").map((part) => escapeRegex(part));
  return parts.join("\\S+");
}

/**
 * Cleanup suspended OpenClaw CLI processes that have accumulated.
 * Only cleans up if there are more than the threshold (default: 10).
 */
export async function cleanupSuspendedCliProcesses(
  backend: CliBackendConfig,
  threshold = 10,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const matchers = buildSessionMatchers(backend);
  if (matchers.length === 0) {
    return;
  }

  try {
    const { stdout } = await runExec("ps", ["-ax", "-o", "pid=,stat=,command="]);
    const suspended: number[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const stat = match[2] ?? "";
      const command = match[3] ?? "";
      if (!Number.isFinite(pid)) {
        continue;
      }
      if (!stat.includes("T")) {
        continue;
      }
      if (!matchers.some((matcher) => matcher.test(command))) {
        continue;
      }
      suspended.push(pid);
    }

    if (suspended.length > threshold) {
      // Verified locally: stopped (T) processes ignore SIGTERM, so use SIGKILL.
      await runExec("kill", ["-9", ...suspended.map((pid) => String(pid))]);
    }
  } catch {
    // ignore errors - best effort cleanup
  }
}
export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  const tracked = chained.finally(() => {
    if (CLI_RUN_QUEUE.get(key) === tracked) {
      CLI_RUN_QUEUE.delete(key);
    }
  });
  CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliOutput = {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
};

function buildModelAliasLines(cfg?: OpenClawConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) {
      continue;
    }
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) {
      continue;
    }
    entries.push({ alias, model });
  }
  return entries
    .toSorted((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

export function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  docsPath?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  modelDisplay: string;
  agentId?: string;
  sessionKey?: string;
}) {
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "openclaw",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
      defaultModel: defaultModelLabel,
    },
  });
  const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    docsPath: params.docsPath,
    runtimeInfo,
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: buildModelAliasLines(params.config),
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: params.contextFiles,
    ttsHint,
    memoryCitationsMode: params.config?.memory?.citations,
    sessionKey: params.sessionKey,
  });
}

export function normalizeCliModel(modelId: string, backend: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const direct = backend.modelAliases?.[trimmed];
  if (direct) {
    return direct;
  }
  const lower = trimmed.toLowerCase();
  const mapped = backend.modelAliases?.[lower];
  if (mapped) {
    return mapped;
  }
  return trimmed;
}

function toUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collectText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectText(entry)).join("");
  }
  if (isRecord(value.message)) {
    return collectText(value.message);
  }
  return "";
}

function pickSessionId(
  parsed: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  const fields = backend.sessionIdFields ?? [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseCliJson(raw: string, backend: CliBackendConfig): CliOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const sessionId = pickSessionId(parsed, backend);
  const usage = isRecord(parsed.usage) ? toUsage(parsed.usage) : undefined;
  const text =
    collectText(parsed.message) ||
    collectText(parsed.content) ||
    collectText(parsed.result) ||
    collectText(parsed);
  return { text: text.trim(), sessionId, usage };
}

export function parseCliJsonl(raw: string, backend: CliBackendConfig): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  const texts: string[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    if (!sessionId) {
      sessionId = pickSessionId(parsed, backend);
    }
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    if (isRecord(parsed.usage)) {
      usage = toUsage(parsed.usage) ?? usage;
    }
    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item && typeof item.text === "string") {
      const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
      if (!type || type.includes("message")) {
        texts.push(item.text);
      }
    }
  }
  const text = texts.join("\n").trim();
  if (!text) {
    return null;
  }
  return { text, sessionId, usage };
}

// 工具调用事件（来自 assistant 消息的 tool_use 内容）
export type CliToolUseEvent = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

// 工具结果事件（来自 user 消息的 tool_result 内容）
export type CliToolResultEvent = {
  toolUseId: string;
  content: string;
  isError: boolean;
};

// stream-json 解析结果（包含事件和最终输出）
export type CliStreamJsonlOutput = CliOutput & {
  toolUses: CliToolUseEvent[];
  toolResults: CliToolResultEvent[];
  /** 检测到的待交互请求（AskUserQuestion 等） */
  pendingInteraction?: DetectedInteraction;
};

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("");
}

/**
 * 检测待交互请求：查找最后一个没有对应 tool_result 的 AskUserQuestion/ExitPlanMode
 */
function detectPendingInteraction(
  toolUses: CliToolUseEvent[],
  toolResults: CliToolResultEvent[],
): DetectedInteraction | undefined {
  // 构建已完成的 tool_use_id 集合
  const completedIds = new Set(toolResults.map((r) => r.toolUseId));

  // 从后往前查找第一个未完成的交互工具调用
  for (let i = toolUses.length - 1; i >= 0; i--) {
    const toolUse = toolUses[i];
    if (!toolUse) continue;

    // 跳过已完成的工具调用
    if (completedIds.has(toolUse.id)) {
      continue;
    }

    // 检测 AskUserQuestion
    if (toolUse.name === "AskUserQuestion") {
      const input = toolUse.input;
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const firstQuestion = questions[0];

      if (firstQuestion && isRecord(firstQuestion)) {
        const question = typeof firstQuestion.question === "string" ? firstQuestion.question : "";
        const multiSelect = Boolean(firstQuestion.multiSelect);
        const rawOptions = Array.isArray(firstQuestion.options) ? firstQuestion.options : [];
        const options: InteractionOption[] = rawOptions
          .filter((opt): opt is Record<string, unknown> => isRecord(opt))
          .map((opt) => ({
            label: typeof opt.label === "string" ? opt.label : "",
            description: typeof opt.description === "string" ? opt.description : undefined,
          }))
          .filter((opt) => opt.label);

        if (question) {
          return {
            type: "ask_user_question",
            toolCallId: toolUse.id,
            question,
            options: options.length > 0 ? options : undefined,
            multiSelect,
          };
        }
      }
    }

    // 检测 ExitPlanMode（Plan 确认）
    if (toolUse.name === "ExitPlanMode") {
      return {
        type: "plan_approval",
        toolCallId: toolUse.id,
        question: "AI 已完成计划制定，是否批准执行？",
      };
    }
  }

  return undefined;
}

/**
 * 解析 Claude CLI stream-json 格式的 JSONL 输出。
 * 提取文本、工具调用、工具结果和用量统计。
 */
export function parseCliStreamJsonl(
  raw: string,
  backend: CliBackendConfig,
): CliStreamJsonlOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  const toolUses: CliToolUseEvent[] = [];
  const toolResults: CliToolResultEvent[] = [];
  const texts: string[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    // 提取 sessionId
    if (!sessionId && typeof parsed.session_id === "string") {
      sessionId = parsed.session_id.trim();
    }
    if (!sessionId) {
      sessionId = pickSessionId(parsed, backend);
    }

    const eventType = typeof parsed.type === "string" ? parsed.type : "";

    // 处理 result 事件（包含最终 usage）
    if (eventType === "result" && isRecord(parsed.usage)) {
      usage = toUsage(parsed.usage) ?? usage;
      // result 事件包含最终文本
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        // 只有在 texts 为空时才使用 result 文本（避免重复）
        if (texts.length === 0) {
          texts.push(parsed.result.trim());
        }
      }
      continue;
    }

    // 处理 assistant 消息
    if (eventType === "assistant") {
      const message = isRecord(parsed.message) ? parsed.message : null;
      if (!message) {
        continue;
      }

      // 提取 usage（每条消息可能有增量 usage）
      if (isRecord(message.usage)) {
        usage = toUsage(message.usage) ?? usage;
      }

      const content = Array.isArray(message.content) ? message.content : null;
      if (!content) {
        continue;
      }

      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }

        const blockType = typeof block.type === "string" ? block.type : "";

        // 提取文本
        if (blockType === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }

        // 提取工具调用
        if (blockType === "tool_use") {
          const id = typeof block.id === "string" ? block.id : "";
          const name = typeof block.name === "string" ? block.name : "";
          const input = isRecord(block.input) ? block.input : {};
          if (id && name) {
            toolUses.push({ id, name, input });
          }
        }
      }
      continue;
    }

    // 处理 user 消息（包含工具结果）
    if (eventType === "user") {
      const message = isRecord(parsed.message) ? parsed.message : null;
      if (!message) {
        continue;
      }

      const content = Array.isArray(message.content) ? message.content : null;
      if (!content) {
        continue;
      }

      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }

        const blockType = typeof block.type === "string" ? block.type : "";

        // 提取工具结果
        if (blockType === "tool_result") {
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const contentStr = extractToolResultText(block.content);
          const isError = Boolean(block.is_error);
          if (toolUseId) {
            toolResults.push({ toolUseId, content: contentStr, isError });
          }
        }
      }
    }
  }

  // 合并所有文本块（最后一个 assistant 消息的文本通常是最终回复）
  const text = texts.join("").trim();

  // 检测待交互请求：查找最后一个没有对应 tool_result 的 AskUserQuestion/ExitPlanMode
  const pendingInteraction = detectPendingInteraction(toolUses, toolResults);

  return { text, sessionId, usage, toolUses, toolResults, pendingInteraction };
}

export function resolveSystemPromptUsage(params: {
  backend: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | null {
  const systemPrompt = params.systemPrompt?.trim();
  if (!systemPrompt) {
    return null;
  }
  const when = params.backend.systemPromptWhen ?? "first";
  if (when === "never") {
    return null;
  }
  if (when === "first" && !params.isNewSession) {
    return null;
  }
  if (!params.backend.systemPromptArg?.trim()) {
    return null;
  }
  return systemPrompt;
}

export function resolveSessionIdToSend(params: {
  backend: CliBackendConfig;
  cliSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const mode = params.backend.sessionMode ?? "always";
  const existing = params.cliSessionId?.trim();
  if (mode === "none") {
    return { sessionId: undefined, isNew: !existing };
  }
  if (mode === "existing") {
    return { sessionId: existing, isNew: !existing };
  }
  if (existing) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: crypto.randomUUID(), isNew: true };
}

export function resolvePromptInput(params: { backend: CliBackendConfig; prompt: string }): {
  argsPrompt?: string;
  stdin?: string;
} {
  const inputMode = params.backend.input ?? "arg";
  if (inputMode === "stdin") {
    return { stdin: params.prompt };
  }
  if (params.backend.maxPromptArgChars && params.prompt.length > params.backend.maxPromptArgChars) {
    return { stdin: params.prompt };
  }
  return { argsPrompt: params.prompt };
}

function resolveImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) {
    return "png";
  }
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  return "bin";
}

export function appendImagePathsToPrompt(prompt: string, paths: string[]): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.join("\n")}`;
}

export async function writeCliImages(
  images: ImageContent[],
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-images-"));
  const paths: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const ext = resolveImageExtension(image.mimeType);
    const filePath = path.join(tempDir, `image-${i + 1}.${ext}`);
    const buffer = Buffer.from(image.data, "base64");
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    paths.push(filePath);
  }
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };
  return { paths, cleanup };
}

export function buildCliArgs(params: {
  backend: CliBackendConfig;
  baseArgs: string[];
  modelId: string;
  sessionId?: string;
  systemPrompt?: string | null;
  imagePaths?: string[];
  promptArg?: string;
  useResume: boolean;
}): string[] {
  const args: string[] = [...params.baseArgs];
  if (!params.useResume && params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (!params.useResume && params.systemPrompt && params.backend.systemPromptArg) {
    args.push(params.backend.systemPromptArg, params.systemPrompt);
  }
  if (!params.useResume && params.sessionId) {
    if (params.backend.sessionArgs && params.backend.sessionArgs.length > 0) {
      for (const entry of params.backend.sessionArgs) {
        args.push(entry.replaceAll("{sessionId}", params.sessionId));
      }
    } else if (params.backend.sessionArg) {
      args.push(params.backend.sessionArg, params.sessionId);
    }
  }
  if (params.imagePaths && params.imagePaths.length > 0) {
    const mode = params.backend.imageMode ?? "repeat";
    const imageArg = params.backend.imageArg;
    if (imageArg) {
      if (mode === "list") {
        args.push(imageArg, params.imagePaths.join(","));
      } else {
        for (const imagePath of params.imagePaths) {
          args.push(imageArg, imagePath);
        }
      }
    }
  }
  if (params.promptArg !== undefined) {
    args.push(params.promptArg);
  }
  return args;
}
