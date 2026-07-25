import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, unlink } from "node:fs/promises";
import { isChildAlive, treeKill } from "./proc.js";
import { pathsFromFileChangeItem } from "./agent-reported-files.js";

const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const STDERR_TAIL_CHARS = 2000;
const DRAIN_MS = 2000;
export const DEFAULT_IDLE_MS = 90_000;
export const DEFAULT_HARD_CAP_MS = 3_600_000;

/**
 * Spawn `codex …`, reduce JSONL for threadId + coarse progress, accept only
 * the private --output-last-message file after a clean exit.
 */
export async function runCodexProcess({
  command,
  args,
  cwd,
  env = process.env,
  resultFile,
  signal,
  onProgress,
  onThreadId,
  timeoutMs = DEFAULT_HARD_CAP_MS,
  idleMs = DEFAULT_IDLE_MS,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  spawnImpl = spawn,
  treeKillImpl = treeKill,
  platform = process.platform,
} = {}) {
  if (!command) throw new TypeError("command required");
  if (!Array.isArray(args)) throw new TypeError("args required");
  if (!resultFile) throw new TypeError("resultFile required");

  let child;
  let timedOut = false;
  let timeoutReason = null;
  let cancelled = false;
  let threadId = null;
  let turnStatus = "running";
  let agentError = null;
  const stderrChunks = [];
  let stderrBytes = 0;
  const reportedPaths = new Set();

  const emit = (message) => {
    try {
      onProgress?.(message);
    } catch {}
  };

  const interruptedBeforeSpawn = async () => {
    const status = "interrupted";
    const exitCode = 1;
    const final = await readFinalResult({
      filePath: resultFile,
      status,
      exitCode,
      maxResultBytes,
    });
    return {
      status,
      exitCode,
      threadId,
      timedOut,
      timeoutReason,
      cancelled: true,
      result: final.result,
      finalMessageAvailable: final.finalMessageAvailable,
      warnings: final.warnings,
      stderrBytes: 0,
      stderrTail: "",
      filesReportedByAgent: [],
    };
  };

  if (signal?.aborted) return interruptedBeforeSpawn();

  const childEnv = { ...env };
  // Recursion marker for nested delegate detection by the parent server.
  childEnv.CODEX_DELEGATE_DEPTH = "1";

  await unlink(resultFile).catch(() => {});

  const spawnOpts = {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  };
  if (platform !== "win32") spawnOpts.detached = true;

  if (signal?.aborted) return interruptedBeforeSpawn();
  child = spawnImpl(command, args, spawnOpts);

  const abort = async ({ userCancel = false } = {}) => {
    if (userCancel) cancelled = true;
    if (isChildAlive(child)) await treeKillImpl(child.pid);
  };

  const onAbort = () => {
    abort({ userCancel: true }).catch(() => {});
  };

  const hardCapMs = timeoutMs > 0 ? timeoutMs : 0;
  let idleTimer;
  let hardCapTimer;

  const clearTimers = () => {
    clearTimeout(idleTimer);
    clearTimeout(hardCapTimer);
    idleTimer = undefined;
    hardCapTimer = undefined;
  };

  const tripTimeout = (reason) => {
    if (timedOut || cancelled) return;
    timedOut = true;
    timeoutReason = reason;
    abort({ userCancel: false }).catch(() => {});
  };

  const resetIdle = () => {
    clearTimeout(idleTimer);
    if (idleMs <= 0 || timedOut || cancelled) return;
    idleTimer = setTimeout(() => tripTimeout("idle-timeout"), idleMs);
    if (!process.env.NODE_TEST_CONTEXT) idleTimer.unref?.();
  };

  const noteActivity = () => {
    resetIdle();
  };

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    noteActivity();
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.type === "thread.started" && event.thread_id) {
      threadId = event.thread_id;
      try {
        onThreadId?.(threadId);
      } catch {}
      emit(`thread started: ${threadId}`);
    } else if (event?.type === "turn.started") {
      turnStatus = "in_progress";
      emit("turn started");
    } else if (event?.type === "turn.completed") {
      turnStatus = "completed";
      emit("turn completed");
    } else if (event?.type === "turn.failed") {
      turnStatus = "failed";
      agentError = agentError || readAgentError(event.error);
      emit("turn failed");
    } else if (event?.type === "error") {
      // Codex reports the actionable reason here; the turn.failed that follows repeats it.
      agentError = agentError || readAgentError(event);
    } else if (event?.type === "item.started" || event?.type === "item.completed") {
      const item = event.item;
      if (!item) return;
      if (item.type === "command_execution") {
        const cmd = String(item.command || item.command_line || "").slice(0, 120);
        emit(cmd ? `running: ${cmd}` : "running command");
      } else if (item.type === "file_change") {
        for (const p of pathsFromFileChangeItem(item)) reportedPaths.add(p);
        const n = Array.isArray(item.changes) ? item.changes.length : 0;
        emit(n ? `editing ${n} file(s)` : "editing files");
      } else if (item.type === "web_search") {
        emit("web search");
      }
    }
  });

  // Bounded: a killed process can leave a grandchild holding stdout, so the
  // interface may never close. Waiting forever would wedge the delegation.
  const drained = Promise.race([
    new Promise((resolve) => rl.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, DRAIN_MS).unref?.()),
  ]);

  child.stderr.on("data", (chunk) => {
    noteActivity();
    if (stderrBytes >= DEFAULT_STDERR_BYTES) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = DEFAULT_STDERR_BYTES - stderrBytes;
    const cappedChunk = buffer.subarray(0, remaining);
    stderrChunks.push(cappedChunk);
    stderrBytes += cappedChunk.length;
  });

  let exitCode;
  try {
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (hardCapMs > 0) {
      hardCapTimer = setTimeout(() => tripTimeout("hard-cap"), hardCapMs);
      if (!process.env.NODE_TEST_CONTEXT) hardCapTimer.unref?.();
    }
    resetIdle();

    exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    // close can land with lines still queued; a dropped turn.failed would read as success.
    await drained;
  } finally {
    clearTimers();
    if (signal) signal.removeEventListener("abort", onAbort);
    rl.close();
  }

  const interrupted = cancelled || timedOut || signal?.aborted;
  let status = "failed";
  if (interrupted) status = "interrupted";
  else if (turnStatus === "failed") status = "failed";
  else if (exitCode === 0 && turnStatus === "in_progress") {
    // Process died mid-turn: do not treat a partial --output-last-message as final.
    status = "failed";
  } else if (exitCode === 0 && (turnStatus === "completed" || turnStatus === "running")) {
    // Some review paths exit cleanly without turn events; still require exit 0.
    status = "completed";
  }

  const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");

  const final = await readFinalResult({
    filePath: resultFile,
    status,
    exitCode,
    maxResultBytes,
  });

  const warnings = [];
  if (agentError) warnings.push(`Codex error: ${agentError}`);
  warnings.push(...final.warnings);
  if (timedOut && timeoutReason === "idle-timeout") {
    warnings.push(
      `Idle timeout after ${idleMs}ms with no Codex activity. Raise CODEX_DELEGATE_IDLE_MS if the task runs long silent commands.`
    );
  } else if (timedOut && timeoutReason === "hard-cap") {
    warnings.push(`Hard-cap timeout after ${hardCapMs}ms.`);
  }
  const stderrTail = meaningfulStderr(stderr).slice(-STDERR_TAIL_CHARS);
  if (status !== "completed" && stderrTail.trim()) {
    warnings.push(`stderr: ${stderrTail.trim()}`);
  }

  return {
    status,
    exitCode,
    threadId,
    timedOut,
    timeoutReason,
    cancelled,
    agentError,
    result: final.result,
    finalMessageAvailable: final.finalMessageAvailable,
    warnings,
    stderrBytes,
    stderrTail: status !== "completed" ? stderrTail : "",
    filesReportedByAgent: [...reportedPaths],
  };
}

/** Codex prints this on every non-TTY run; it is not a diagnosis. */
const BENIGN_STDERR = /^Reading additional input from stdin\.\.\.$/;

export function meaningfulStderr(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .filter((line) => !BENIGN_STDERR.test(line.trim()))
    .join("\n");
}

/**
 * Codex nests the actionable reason as a JSON string inside error.message.
 * Unwrap one level so the caller reads prose, not a serialized envelope.
 */
export function readAgentError(source, maxChars = 600) {
  const raw = typeof source === "string" ? source : source?.message;
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let message = text;
  try {
    const parsed = JSON.parse(text);
    const nested = parsed?.error?.message ?? parsed?.message;
    if (typeof nested === "string" && nested.trim()) message = nested.trim();
  } catch {}
  return message.length > maxChars ? `${message.slice(0, maxChars)}…` : message;
}

export async function readFinalResult({
  filePath,
  status,
  exitCode,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  readFileImpl = readFile,
} = {}) {
  if (status !== "completed" || exitCode !== 0) {
    return {
      result: "",
      finalMessageAvailable: false,
      warnings: [`Final result unavailable (status=${status}, exit=${exitCode}).`],
    };
  }
  try {
    const result = await readFileImpl(filePath, "utf8");
    if (Buffer.byteLength(result, "utf8") > maxResultBytes) {
      return {
        result: "",
        finalMessageAvailable: false,
        warnings: [`Final result exceeds ${maxResultBytes} bytes.`],
      };
    }
    return { result, finalMessageAvailable: true, warnings: [] };
  } catch {
    return {
      result: "",
      finalMessageAvailable: false,
      warnings: ["Final result file missing or unreadable."],
    };
  }
}
