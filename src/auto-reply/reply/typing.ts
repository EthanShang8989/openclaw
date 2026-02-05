import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type TypingController = {
  onReplyStart: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: () => void;
  isActive: () => boolean;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  cleanup: () => void;
};

export function createTypingController(params: {
  onReplyStart?: () => Promise<void> | void;
  typingIntervalSeconds?: number;
  typingTtlMs?: number;
  silentToken?: string;
  log?: (message: string) => void;
  /** 超时后的回调，用于发送提示消息 */
  onTypingTimeout?: (elapsedMs: number) => Promise<void> | void;
  /** 超时提示的重复间隔（毫秒），默认 5 分钟 */
  typingTimeoutReminderIntervalMs?: number;
}): TypingController {
  const {
    onReplyStart,
    typingIntervalSeconds = 6,
    typingTtlMs = 2 * 60_000,
    silentToken = SILENT_REPLY_TOKEN,
    log,
    onTypingTimeout,
    typingTimeoutReminderIntervalMs = 5 * 60_000,
  } = params;
  let started = false;
  let active = false;
  let runComplete = false;
  let dispatchIdle = false;
  let typingStartedAt: number | undefined;
  let typingTimeoutReminderTimer: NodeJS.Timeout | undefined;
  // Important: callbacks (tool/block streaming) can fire late (after the run completed),
  // especially when upstream event emitters don't await async listeners.
  // Once we stop typing, we "seal" the controller so late events can't restart typing forever.
  let sealed = false;
  let typingTimer: NodeJS.Timeout | undefined;
  let typingTtlTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs = typingIntervalSeconds * 1000;

  const formatTypingTtl = (ms: number) => {
    if (ms % 60_000 === 0) {
      return `${ms / 60_000}m`;
    }
    return `${Math.round(ms / 1000)}s`;
  };

  const resetCycle = () => {
    started = false;
    active = false;
    runComplete = false;
    dispatchIdle = false;
  };

  const cleanup = () => {
    if (sealed) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    if (typingTimeoutReminderTimer) {
      clearInterval(typingTimeoutReminderTimer);
      typingTimeoutReminderTimer = undefined;
    }
    resetCycle();
    sealed = true;
  };

  const refreshTypingTtl = () => {
    if (sealed) {
      return;
    }
    if (!typingIntervalMs || typingIntervalMs <= 0) {
      return;
    }
    if (typingTtlMs <= 0) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
    }
    typingTtlTimer = setTimeout(() => {
      if (!typingTimer) {
        return;
      }
      log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
      // 停止 typing 循环但不完全 cleanup，继续发送超时提醒
      if (typingTimer) {
        clearInterval(typingTimer);
        typingTimer = undefined;
      }
      if (typingTtlTimer) {
        clearTimeout(typingTtlTimer);
        typingTtlTimer = undefined;
      }
      // 触发超时回调
      if (onTypingTimeout && typingStartedAt) {
        const elapsedMs = Date.now() - typingStartedAt;
        void onTypingTimeout(elapsedMs);
        // 启动定时提醒
        if (typingTimeoutReminderIntervalMs > 0 && !typingTimeoutReminderTimer) {
          typingTimeoutReminderTimer = setInterval(() => {
            if (sealed || runComplete) {
              if (typingTimeoutReminderTimer) {
                clearInterval(typingTimeoutReminderTimer);
                typingTimeoutReminderTimer = undefined;
              }
              return;
            }
            if (typingStartedAt) {
              void onTypingTimeout(Date.now() - typingStartedAt);
            }
          }, typingTimeoutReminderIntervalMs);
        }
      }
    }, typingTtlMs);
  };

  const isActive = () => active && !sealed;

  const triggerTyping = async () => {
    if (sealed) {
      return;
    }
    await onReplyStart?.();
  };

  const ensureStart = async () => {
    if (sealed) {
      return;
    }
    // Late callbacks after a run completed should never restart typing.
    if (runComplete) {
      return;
    }
    if (!active) {
      active = true;
    }
    if (started) {
      return;
    }
    started = true;
    typingStartedAt = Date.now();
    await triggerTyping();
  };

  const maybeStopOnIdle = () => {
    if (!active) {
      return;
    }
    // Stop only when the model run is done and the dispatcher queue is empty.
    if (runComplete && dispatchIdle) {
      cleanup();
    }
  };

  const startTypingLoop = async () => {
    if (sealed) {
      return;
    }
    if (runComplete) {
      return;
    }
    // Always refresh TTL when called, even if loop already running.
    // This keeps typing alive during long tool executions.
    refreshTypingTtl();
    if (!onReplyStart) {
      return;
    }
    if (typingIntervalMs <= 0) {
      return;
    }
    if (typingTimer) {
      return;
    }
    await ensureStart();
    typingTimer = setInterval(() => {
      void triggerTyping();
    }, typingIntervalMs);
  };

  const startTypingOnText = async (text?: string) => {
    if (sealed) {
      return;
    }
    const trimmed = text?.trim();
    if (!trimmed) {
      return;
    }
    if (silentToken && isSilentReplyText(trimmed, silentToken)) {
      return;
    }
    refreshTypingTtl();
    await startTypingLoop();
  };

  const markRunComplete = () => {
    runComplete = true;
    maybeStopOnIdle();
  };

  const markDispatchIdle = () => {
    dispatchIdle = true;
    maybeStopOnIdle();
  };

  return {
    onReplyStart: ensureStart,
    startTypingLoop,
    startTypingOnText,
    refreshTypingTtl,
    isActive,
    markRunComplete,
    markDispatchIdle,
    cleanup,
  };
}
