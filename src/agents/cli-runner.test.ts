import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendConfig } from "../config/types.js";
import { runCliAgent } from "./cli-runner.js";
import { cleanupSuspendedCliProcesses, parseCliStreamJsonl } from "./cli-runner/helpers.js";

const runCommandWithTimeoutMock = vi.fn();
const runExecMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

describe("runCliAgent resume cleanup", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runExecMock.mockReset();
  });

  it("kills stale resume processes for codex sessions", async () => {
    runExecMock
      .mockResolvedValueOnce({
        stdout: "  1 S /bin/launchd\n",
        stderr: "",
      }) // cleanupSuspendedCliProcesses (ps)
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // cleanupResumeProcesses (pkill)
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-1",
      cliSessionId: "thread-123",
    });

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).toHaveBeenCalledTimes(2);
    const pkillCall = runExecMock.mock.calls[1] ?? [];
    expect(pkillCall[0]).toBe("pkill");
    const pkillArgs = pkillCall[1] as string[];
    expect(pkillArgs[0]).toBe("-f");
    expect(pkillArgs[1]).toContain("codex");
    expect(pkillArgs[1]).toContain("resume");
    expect(pkillArgs[1]).toContain("thread-123");
  });

  it("single-quotes all sandbox command args when using docker exec", async () => {
    runExecMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: '{"thread_id":"t1","item":{"type":"message","text":"ok"}}',
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello; echo pwned",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-sandbox-1",
      sandboxContext: {
        enabled: true,
        sessionKey: "s1",
        workspaceDir: "/tmp",
        agentWorkspaceDir: "/tmp",
        workspaceAccess: "rw",
        containerName: "openclaw-test",
        containerWorkdir: "/workspace",
        docker: {
          image: "test",
          containerPrefix: "openclaw",
          workdir: "/workspace",
          readOnlyRoot: false,
          tmpfs: [],
          network: "none",
          capDrop: [],
          env: {},
        },
        tools: {},
        browserAllowHostControl: false,
      },
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    const argv = runCommandWithTimeoutMock.mock.calls[0]?.[0] as string[];
    expect(argv[0]).toBe("docker");
    expect(argv).toContain("sh");
    expect(argv).toContain("-lc");
    const shellCommand = argv[argv.length - 1] ?? "";
    expect(shellCommand).toContain("'codex'");
    expect(shellCommand).toContain("'hello; echo pwned'");
    expect(shellCommand).not.toContain(" hello; echo pwned");
  });
});

describe("cleanupSuspendedCliProcesses", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  it("skips when no session tokens are configured", async () => {
    await cleanupSuspendedCliProcesses(
      {
        command: "tool",
      } as CliBackendConfig,
      0,
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).not.toHaveBeenCalled();
  });

  it("matches sessionArg-based commands", async () => {
    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          "  40 T+ claude --session-id thread-1 -p",
          "  41 S  claude --session-id thread-2 -p",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await cleanupSuspendedCliProcesses(
      {
        command: "claude",
        sessionArg: "--session-id",
      } as CliBackendConfig,
      0,
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).toHaveBeenCalledTimes(2);
    const killCall = runExecMock.mock.calls[1] ?? [];
    expect(killCall[0]).toBe("kill");
    expect(killCall[1]).toEqual(["-9", "40"]);
  });

  it("matches resumeArgs with positional session id", async () => {
    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          "  50 T  codex exec resume thread-99 --color never --sandbox read-only",
          "  51 T  codex exec resume other --color never --sandbox read-only",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await cleanupSuspendedCliProcesses(
      {
        command: "codex",
        resumeArgs: ["exec", "resume", "{sessionId}", "--color", "never", "--sandbox", "read-only"],
      } as CliBackendConfig,
      1,
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).toHaveBeenCalledTimes(2);
    const killCall = runExecMock.mock.calls[1] ?? [];
    expect(killCall[0]).toBe("kill");
    expect(killCall[1]).toEqual(["-9", "50", "51"]);
  });
});

describe("parseCliStreamJsonl", () => {
  it("extracts text from array-form tool_result content blocks", () => {
    const raw = [
      JSON.stringify({
        type: "assistant",
        session_id: "sid-1",
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { q: "x" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "result line 1" }, { type: "text", text: " + line 2" }],
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseCliStreamJsonl(raw, { command: "claude" } as CliBackendConfig);
    expect(parsed?.toolResults).toEqual([
      { toolUseId: "toolu_1", content: "result line 1 + line 2", isError: false },
    ]);
  });
});
