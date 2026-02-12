import type { SessionEntry } from "../config/sessions.js";
import { normalizeProviderId } from "./model-selection.js";

export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromMap = entry.cliSessionIds?.[normalized];
  if (fromMap?.trim()) {
    return fromMap.trim();
  }
  if (normalized === "claude-cli") {
    const legacy = entry.claudeCliSessionId?.trim();
    if (legacy) {
      return legacy;
    }
  }
  return undefined;
}

export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return;
  }
  const existing = entry.cliSessionIds ?? {};
  entry.cliSessionIds = { ...existing };
  entry.cliSessionIds[normalized] = trimmed;
  if (normalized === "claude-cli") {
    entry.claudeCliSessionId = trimmed;
  }
}

export function clearCliSessionId(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliSessionIds) {
    delete entry.cliSessionIds[normalized];
  }
  if (normalized === "claude-cli") {
    delete entry.claudeCliSessionId;
  }
}

export function clearAllCliSessionIds(entry: SessionEntry): void {
  delete entry.cliSessionIds;
  delete entry.claudeCliSessionId;
}
