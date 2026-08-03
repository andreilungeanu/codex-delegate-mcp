import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, unlink } from "node:fs/promises";
import { isChildAlive, treeKill } from "./proc.js";
import { pathsFromFileChangeItem } from "./edit-tool-files.js";

const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const STDERR_TAIL_CHARS = 2000;
const DRAIN_MS = 2000;
/** Spawn to first JSONL event. Silence here does mean a wedged launcher. */
export const DEFAULT_STARTUP_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
/** How long to wait for the process to actually die after a kill is requested. */
export const DEFAULT_KILL_DEADLINE_MS = 10_000;
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
  startupMs = DEFAULT_STARTUP_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  killDeadlineMs = DEFAULT_KILL_DEADLINE_MS,
  drainMs = DRAIN_MS,
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
  let lastAgentMessage = null;
  let usage = null;
  const failedItems = [];
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
      reason: "cancelled",
      exitCode,
      threadId,
      result: final.result,
      finalMessageAvailable: final.finalMessageAvailable,
      warnings: final.warnings,
      stderrBytes: 0,
      stderrTail: "",
      filesReportedByEditTools: [],
    };
  };

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

  // 'exit' means the process is gone. 'close' additionally waits for every stdio
  // pipe, including any a background process Codex started inherited — that can
  // be minutes or hours later, so the exit code must not depend on it.
  let settleExit;
  const exited = new Promise((resolve, reject) => {
    settleExit = resolve;
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    child.on("close", (code) => resolve(code));
  });
  const pipesClosed = new Promise((resolve) => child.on("close", resolve));

  let killTimer;
  let killEscaped = false;
  /**
   * treeKill is best effort — taskkill can report success and leave the tree up.
   * Without this the close we await never arrives and the delegation, and the
   * single-slot registry behind it, wedge for the life of the process.
   */
  const armKillDeadline = () => {
    if (killTimer || killDeadlineMs <= 0) return;
    killTimer = setTimeout(() => {
      killEscaped = true;
      settleExit(null);
    }, killDeadlineMs);
  };

  const abort = async ({ userCancel = false } = {}) => {
    if (userCancel) cancelled = true;
    armKillDeadline();
    if (isChildAlive(child)) await treeKillImpl(child.pid);
  };

  const onAbort = () => {
    abort({ userCancel: true }).catch(() => {});
  };

  const hardCapMs = timeoutMs > 0 ? timeoutMs : 0;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let lastCommand = null;
  let sawFirstEvent = false;
  let hardCapTimer;
  let startupTimer;
  let heartbeatTimer;

  const clearTimers = () => {
    clearTimeout(hardCapTimer);
    clearTimeout(startupTimer);
    clearTimeout(killTimer);
    clearInterval(heartbeatTimer);
    hardCapTimer = undefined;
    startupTimer = undefined;
    heartbeatTimer = undefined;
  };

  const tripTimeout = (reason) => {
    if (timedOut || cancelled) return;
    timedOut = true;
    timeoutReason = reason;
    abort({ userCancel: false }).catch(() => {});
  };

  // No mid-turn idle guard: Codex emits nothing for the body of a shell command
  // or a long reasoning pass, so silence cannot be told apart from wedged.
  // Only the startup deadline and the hard cap bound a run.
  const noteActivity = () => {
    lastActivityAt = Date.now();
    if (!sawFirstEvent) {
      sawFirstEvent = true;
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
  };

  const heartbeat = () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const quiet = Math.round((Date.now() - lastActivityAt) / 1000);
    const running = lastCommand ? `, running: ${lastCommand}` : "";
    emit(`still working — ${elapsed}s elapsed, last event ${quiet}s ago${running}`);
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
      usage = readUsage(event.usage) ?? usage;
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
      // A denied or failing tool call leaves the turn "completed"; without this
      // a run where nothing worked is indistinguishable from one that did.
      if (event.type === "item.completed" && item.status === "failed") {
        failedItems.push(describeFailedItem(item));
      }
      if (item.type === "command_execution") {
        const cmd = String(item.command || item.command_line || "").slice(0, 120);
        lastCommand = event.type === "item.completed" ? null : cmd || null;
        emit(cmd ? `running: ${cmd}` : "running command");
      } else if (item.type === "file_change") {
        for (const p of pathsFromFileChangeItem(item)) reportedPaths.add(p);
        const n = Array.isArray(item.changes) ? item.changes.length : 0;
        emit(n ? `editing ${n} file(s)` : "editing files");
      } else if (item.type === "agent_message") {
        // Narration, not the answer. Kept only to salvage something when the
        // authoritative --output-last-message file never gets written.
        const text = String(item.text || "").trim();
        if (text) lastAgentMessage = text;
      } else if (item.type === "web_search") {
        emit("web search");
      }
    }
  });

  const drained = new Promise((resolve) => rl.once("close", resolve));

  // A rolling tail, not the first 64 KB: the diagnosis is the last thing a dying
  // process writes, and stderrTail then takes the tail of whatever this kept. Keep
  // the head and a megabyte of noise buries the one line that says why.
  child.stderr.on("data", (chunk) => {
    noteActivity();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buffer.length) return;
    stderrChunks.push(buffer);
    stderrBytes += buffer.length;
    while (stderrBytes > DEFAULT_STDERR_BYTES) {
      const excess = stderrBytes - DEFAULT_STDERR_BYTES;
      const oldest = stderrChunks[0];
      if (oldest.length <= excess) {
        stderrChunks.shift();
        stderrBytes -= oldest.length;
      } else {
        stderrChunks[0] = oldest.subarray(excess);
        stderrBytes -= excess;
      }
    }
  });

  let exitCode;
  let drainEscaped = false;
  try {
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (hardCapMs > 0) hardCapTimer = setTimeout(() => tripTimeout("hard-cap"), hardCapMs);
    if (startupMs > 0) startupTimer = setTimeout(() => tripTimeout("startup-timeout"), startupMs);
    if (heartbeatMs > 0) heartbeatTimer = setInterval(heartbeat, heartbeatMs);

    // Every settle path lands here, and two of them carry no code: a death by
    // signal, and the kill deadline giving up on a tree that refuses to die. A
    // null here fails output validation and takes the whole result with it —
    // thread id, edited files, warnings — precisely when the run went wrong.
    exitCode = (await exited) ?? 1;
    // The pipes can still hold queued lines; a dropped turn.failed would read as
    // success. Bounded, and only from the exit onwards: whatever inherited stdout
    // may hold it open for its own lifetime, and waiting on that would wedge the
    // delegation and the single-slot registry behind it for exactly that long.
    drainEscaped = !(await withDeadline(Promise.all([pipesClosed, drained]), drainMs));
  } finally {
    clearTimers();
    if (signal) signal.removeEventListener("abort", onAbort);
    rl.close();
    // Nothing reads these now, and something may still be writing to them.
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  const interrupted = cancelled || timedOut || signal?.aborted;
  let status = "failed";
  // One outcome, one reason. `reason` replaces the timedOut/cancelled booleans:
  // it says which of the several ways to not finish actually happened.
  let reason;
  if (interrupted) {
    status = "interrupted";
    reason = timedOut ? timeoutReason : "cancelled";
  } else if (turnStatus === "failed") {
    status = "failed";
    reason = "agent-error";
  } else if (exitCode === 0 && turnStatus === "in_progress") {
    // Process died mid-turn: do not treat a partial --output-last-message as final.
    status = "failed";
    reason = "died-mid-turn";
  } else if (exitCode === 0 && (turnStatus === "completed" || turnStatus === "running")) {
    // Some review paths exit cleanly without turn events; still require exit 0.
    status = "completed";
  } else {
    reason = "exit-nonzero";
  }

  const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");

  const final = await readFinalResult({
    filePath: resultFile,
    status,
    exitCode,
    maxResultBytes,
  });

  // The file is authoritative and is only written on a clean exit. When it is
  // absent, the last narration line is better than nothing — but it is never
  // allowed to stand in for a final answer on a run that actually completed.
  let result = final.result;
  let resultSource;
  const fallbackWarnings = [];
  if (!final.finalMessageAvailable && lastAgentMessage) {
    // Capped like the file path: a run whose authoritative file is missing is the
    // more likely one to be pathological, not the less, and this path used to
    // hand back whatever the CLI streamed at whatever size it streamed it.
    const capped = capResultBytes(lastAgentMessage, maxResultBytes);
    result = capped.text;
    resultSource = "stream-fallback";
    fallbackWarnings.push(...capped.warnings);
  }

  const warnings = [];
  if (agentError) warnings.push(`Codex error: ${agentError}`);
  warnings.push(...final.warnings, ...fallbackWarnings);
  if (timedOut && timeoutReason === "startup-timeout") {
    warnings.push(
      `Codex produced no output within ${startupMs}ms of spawning. Run doctor to check the CLI resolves and is logged in; raise CODEX_DELEGATE_STARTUP_MS on a slow machine.`
    );
  } else if (timedOut && timeoutReason === "hard-cap") {
    warnings.push(`Hard-cap timeout after ${hardCapMs}ms. Raise timeoutMs for longer tasks.`);
  }
  if (failedItems.length) {
    const shown = failedItems.slice(0, 3).join("; ");
    const more = failedItems.length > 3 ? ` (+${failedItems.length - 3} more)` : "";
    warnings.push(
      `${failedItems.length} Codex tool call(s) failed during this turn: ${shown}${more}. The reply may describe work that did not happen.`
    );
  }
  if (killEscaped) {
    warnings.push(
      `Codex did not exit within ${killDeadlineMs}ms of being killed; a process may still be running. Check for stray codex processes.`
    );
  } else if (drainEscaped) {
    warnings.push(
      `Codex exited but something it started still holds its output open after ${drainMs}ms — a server or watcher is probably still running in the workspace.`
    );
  }
  const stderrTail = meaningfulStderr(stderr).slice(-STDERR_TAIL_CHARS);
  if (status !== "completed" && stderrTail.trim()) {
    warnings.push(`stderr: ${stderrTail.trim()}`);
  }

  return {
    status,
    reason,
    exitCode,
    threadId,
    agentError,
    usage,
    result,
    resultSource,
    finalMessageAvailable: final.finalMessageAvailable,
    warnings,
    stderrBytes,
    stderrTail: status !== "completed" ? stderrTail : "",
    filesReportedByEditTools: [...reportedPaths],
  };
}

/**
 * Trim to a UTF-8 byte budget, backing off to a codepoint boundary so the cut
 * cannot emit a replacement character. Discarding an oversized result — what the
 * cap used to do — throws the answer away to punish its length; the front of it
 * plus a warning tells the caller both what was said and that it was cut.
 */
export function capResultBytes(text, maxResultBytes) {
  const value = String(text ?? "");
  const bytes = Buffer.byteLength(value, "utf8");
  if (!(maxResultBytes > 0) || bytes <= maxResultBytes) return { text: value, warnings: [] };
  const buffer = Buffer.from(value, "utf8");
  let end = maxResultBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: buffer.subarray(0, end).toString("utf8"),
    warnings: [`Result was ${bytes} bytes, truncated to the ${maxResultBytes} byte cap.`],
  };
}

/**
 * Resolve true if the promise settled inside the deadline, false if the deadline
 * won. The timer is cleared either way: an unref'd one lets the process fall out
 * from under a still-pending wait, and a live one outlives the answer.
 */
function withDeadline(promise, ms) {
  if (!(ms > 0)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

/** Codex reports per-turn token counts; nothing else in the pipeline does. */
export function readUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (key) => (Number.isFinite(raw[key]) ? raw[key] : undefined);
  const usage = {
    inputTokens: pick("input_tokens"),
    cachedInputTokens: pick("cached_input_tokens"),
    cacheWriteInputTokens: pick("cache_write_input_tokens"),
    outputTokens: pick("output_tokens"),
    reasoningOutputTokens: pick("reasoning_output_tokens"),
  };
  const kept = Object.entries(usage).filter(([, v]) => v !== undefined);
  return kept.length ? Object.fromEntries(kept) : null;
}

export function describeFailedItem(item, maxChars = 120) {
  const kind = String(item?.type || "item");
  const detail = String(item?.command || item?.command_line || "").trim();
  const exit = Number.isInteger(item?.exit_code) ? ` exit ${item.exit_code}` : "";
  const label = detail ? `${kind} "${detail.slice(0, maxChars)}"` : kind;
  return `${label}${exit}`;
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
      warnings: [],
    };
  }
  try {
    const capped = capResultBytes(await readFileImpl(filePath, "utf8"), maxResultBytes);
    return { result: capped.text, finalMessageAvailable: true, warnings: capped.warnings };
  } catch {
    return {
      result: "",
      finalMessageAvailable: false,
      warnings: ["Final result file missing or unreadable."],
    };
  }
}
