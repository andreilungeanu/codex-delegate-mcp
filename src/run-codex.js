import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { open as openFile, unlink } from "node:fs/promises";
import { isChildAlive, treeKill } from "./proc.js";
import { pathsFromFileChangeItem } from "./edit-tool-files.js";

/**
 * Deliberately generous. This is the ceiling that stops a runaway process, not a
 * budget for the caller's context: an answer is worth more delivered whole than
 * cut to fit a window, and the windows keep getting bigger.
 */
const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const STDERR_TAIL_CHARS = 2000;
const DRAIN_MS = 2000;
/**
 * Both of these are chosen by the child process and echoed back verbatim, so both
 * need a ceiling. A real thread id is a 36-character uuid; a run that edits more
 * files than this has a git diff worth reading instead of a list worth shipping.
 */
const MAX_THREAD_ID_CHARS = 200;
const MAX_REPORTED_PATHS = 500;
/** Spawn to first JSONL event. Silence here does mean a wedged launcher. */
export const DEFAULT_STARTUP_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
/** How long to wait for the process to actually die after a kill is requested. */
export const DEFAULT_KILL_DEADLINE_MS = 10_000;
export const DEFAULT_HARD_CAP_MS = 3_600_000;

/**
 * Spawn `codex …`, reduce JSONL for threadId + coarse progress, accept only
 * the private --output-last-message file after a clean exit.
 *
 * @param {{
 *   command?: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   resultFile?: string,
 *   stdin?: string | null,
 *   signal?: AbortSignal,
 *   onProgress?: (message: string) => void,
 *   onThreadId?: (threadId: string) => void,
 *   timeoutMs?: number,
 *   startupMs?: number,
 *   heartbeatMs?: number,
 *   killDeadlineMs?: number,
 *   drainMs?: number,
 *   maxResultBytes?: number,
 *   spawnImpl?: any,
 *   treeKillImpl?: any,
 *   platform?: string,
 * }} [options]
 */
export async function runCodexProcess({
  command,
  args,
  cwd,
  env = process.env,
  resultFile,
  stdin = null,
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

  const emit = (message) => {
    try {
      onProgress?.(message);
    } catch {}
  };

  // Everything the JSONL stream reports, and the rolling stderr tail, keep their
  // own state. What is left in this scope is the child and the flags that say how
  // the run ended — the things the lifecycle below actually manipulates.
  const { state: events, handleLine } = createEventReducer({ emit, onThreadId });
  const stderrBuffer = createStderrTail(DEFAULT_STDERR_BYTES);

  // Nothing has been spawned, so there is nothing to report and nothing to read:
  // the final-message file is only ever accepted after a clean exit, and this run
  // never had one. Asking readFinalResult would return the same empty answer by way
  // of its own status guard.
  const interruptedBeforeSpawn = () => ({
    status: "interrupted",
    reason: "cancelled",
    exitCode: 1,
    threadId: null,
    result: "",
    finalMessageAvailable: false,
    warnings: [],
    stderrBytes: 0,
    stderrTail: "",
    filesReportedByEditTools: [],
  });

  const childEnv = { ...env };
  // Recursion marker for nested delegate detection by the parent server.
  childEnv.CODEX_DELEGATE_DEPTH = "1";

  await unlink(resultFile).catch(() => {});

  // The parent's own stdin is the MCP channel and must never reach the child, which
  // would read it straight into the prompt. A pipe we create and close ourselves is
  // a different thing: the child sees only what we write.
  const sendsStdin = typeof stdin === "string";
  const spawnOpts = {
    cwd,
    env: childEnv,
    stdio: [sendsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  };
  if (platform !== "win32") spawnOpts.detached = true;

  if (signal?.aborted) return interruptedBeforeSpawn();
  child = spawnImpl(command, args, spawnOpts);
  const childPid = child.pid;

  // readline attaches no error listener of its own, so an EPIPE on either pipe
  // lands on a stream nobody is watching and takes the server down — the same way
  // stdin used to before it got the listener below.
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});

  // Written and closed immediately. Codex waits for EOF before it starts, and an
  // open pipe would also hold back the 'close' this run waits on — so a stdin left
  // dangling wedges the delegation as surely as an escaped child does.
  if (sendsStdin && child.stdin) {
    // A child that dies mid-write raises EPIPE/ERR_STREAM_DESTROYED on a stream
    // nobody is listening to, which takes down the whole server.
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(stdin);
    } catch {}
  }

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
   * Without this the close we await never arrives and the delegation wedges for
   * the life of the process, holding its slot in the registry with it.
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
    // Runs for an exited child too. Codex dying does not reap the shell, watcher or
    // test run it spawned; on POSIX those stay in its process group, and skipping
    // the kill here is what leaves them behind. Recording the pid at spawn does not
    // make it unrecyclable — it is the same integer either way. What bounds the risk
    // is that this only ever runs inside a live run, so the group is at most one
    // drain old; do not reuse it for a later sweep.
    await treeKillImpl(childPid, { childAlive: isChildAlive(child) });
  };

  const onAbort = () => {
    abort({ userCancel: true }).catch(() => {});
  };

  const hardCapMs = timeoutMs > 0 ? timeoutMs : 0;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
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
  };

  // Only a parsed JSONL event clears the startup deadline. That deadline is the one
  // guard on a launcher that never gets going, and a diagnostic on stderr or a banner
  // on stdout is exactly what such a launcher emits on its way to wedging — counting
  // either as "started" handed the run the whole hard cap instead. Both still count
  // as activity, which is what the heartbeat reports.
  const noteEvent = () => {
    noteActivity();
    if (sawFirstEvent) return;
    sawFirstEvent = true;
    clearTimeout(startupTimer);
    startupTimer = undefined;
  };

  const heartbeat = () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const quiet = Math.round((Date.now() - lastActivityAt) / 1000);
    const running = events.lastCommand ? `, running: ${events.lastCommand}` : "";
    emit(`still working — ${elapsed}s elapsed, last event ${quiet}s ago${running}`);
  };

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  // readline forwards an input error onto the interface, so listening on stdout
  // alone still leaves the re-emitted copy unhandled here.
  rl.on("error", () => {});
  rl.on("line", (line) => {
    if (handleLine(line)) noteEvent();
    else noteActivity();
  });

  const drained = new Promise((resolve) => rl.once("close", resolve));

  child.stderr.on("data", (chunk) => {
    noteActivity();
    stderrBuffer.push(chunk);
  });

  let exitCode;
  let interrupted = false;
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
    // Read once, here, rather than after the drain below: `interrupted` discards the
    // final-message file, so a cancel landing in the drain window would throw away an
    // answer the child had already finished writing. A cancel that caused this exit
    // set its flag before the exit arrived, so it is still caught.
    interrupted = cancelled || timedOut || Boolean(signal?.aborted);
    // Disarmed on the same boundary the classification is read from. A hard cap or
    // kill deadline that fires during the drain below has nothing left to interrupt,
    // and would only contradict the outcome already decided: a completed run warning
    // that it timed out, or a killEscaped warning about a process that has exited.
    clearTimers();
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

  // Classification runs before the file read, and every path that can outrank
  // the file — cancellation, timeouts, turn failure, a non-zero exit — is decided
  // there. Only a process that otherwise completed can be demoted by its final
  // result: a missing or unreadable file means the CLI broke its output contract,
  // and `completed` must never assert an answer the bridge could not read.
  const outcome = classifyOutcome({
    interrupted,
    timedOut,
    timeoutReason,
    turnStatus: events.turnStatus,
    exitCode,
  });

  const final = await readFinalResult({
    filePath: resultFile,
    status: outcome.status,
    exitCode,
    maxResultBytes,
  });

  const resultUnavailable = outcome.status === "completed" && !final.finalMessageAvailable;
  const status = resultUnavailable ? "failed" : outcome.status;
  const reason = resultUnavailable ? "result-unavailable" : outcome.reason;

  const result = final.result;

  const stderrTail = meaningfulStderr(stderrBuffer.text()).slice(-STDERR_TAIL_CHARS);

  const warnings = buildRunWarnings({
    agentError: events.agentError,
    resultWarnings: final.warnings,
    timedOut,
    timeoutReason,
    startupMs,
    hardCapMs,
    unusableThreadIdChars: events.unusableThreadIdChars,
    pathsTruncated: events.pathsTruncated,
    nonSuccessfulItems: events.nonSuccessfulItems,
    killEscaped,
    killDeadlineMs,
    drainEscaped,
    drainMs,
    status,
    stderrTail,
  });

  return {
    status,
    reason,
    exitCode,
    threadId: events.threadId,
    agentError: events.agentError,
    usage: events.usage,
    result,
    finalMessageAvailable: final.finalMessageAvailable,
    warnings,
    stderrBytes: stderrBuffer.bytes,
    stderrTail: status !== "completed" ? stderrTail : "",
    filesReportedByEditTools: [...events.reportedPaths],
  };
}

/**
 * Reduce the JSONL event stream to the handful of facts the result is built from.
 * Everything it accumulates is read once, after the run settles — `lastCommand` is
 * the exception, and the heartbeat reads it while the run is still going.
 */
function createEventReducer({ emit, onThreadId }) {
  const state = {
    threadId: null,
    turnStatus: "running",
    agentError: null,
    usage: null,
    nonSuccessfulItems: [],
    reportedPaths: new Set(),
    pathsTruncated: false,
    unusableThreadIdChars: 0,
    lastCommand: null,
  };

  /**
   * Reports whether the line was a JSONL event at all. The caller needs that apart
   * from anything the event said: it is what the startup deadline is waiting for,
   * and a line Codex printed that is not JSON is not the launcher getting going.
   *
   * @returns {boolean}
   */
  const handleLine = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    reduce(event);
    return true;
  };

  const reduce = (event) => {
    if (event?.type === "thread.started" && event.thread_id) {
      const id = String(event.thread_id);
      // Truncating would produce a plausible id that resumes nothing and matches
      // no cancel; refusing it loses the same run and says so.
      if (id.length > MAX_THREAD_ID_CHARS) {
        state.unusableThreadIdChars = id.length;
        return;
      }
      state.threadId = id;
      try {
        onThreadId?.(state.threadId);
      } catch {}
      emit(`thread started: ${state.threadId}`);
    } else if (event?.type === "turn.started") {
      state.turnStatus = "in_progress";
      emit("turn started");
    } else if (event?.type === "turn.completed") {
      state.turnStatus = "completed";
      state.usage = readUsage(event.usage) ?? state.usage;
      emit("turn completed");
    } else if (event?.type === "turn.failed") {
      state.turnStatus = "failed";
      state.agentError = state.agentError || readAgentError(event.error);
      emit("turn failed");
    } else if (event?.type === "error") {
      // Codex reports the actionable reason here; the turn.failed that follows repeats it.
      state.agentError = state.agentError || readAgentError(event);
    } else if (event?.type === "item.started" || event?.type === "item.completed") {
      const item = event.item;
      if (!item) return;
      // Codex announces each item twice. The two events carry the same description,
      // so only the first is worth a notification — the second used to repeat it,
      // and announced a finished command with the word "running".
      const started = event.type === "item.started";
      // A failed or declined tool call leaves the turn "completed"; without this
      // a run where nothing worked is indistinguishable from one that did.
      // Report the producer's status as fact and nothing more: Codex marks a
      // command_execution "failed" on any non-zero exit, which is the normal
      // outcome of a red test suite, so this cannot stand in for proof that the
      // work did not happen. On Windows the reported code is the shell's, not the
      // program's — pwsh -Command collapses a denial, a red suite, a missing binary
      // and a clean `process.exit(3)` all to exit 1 — so neither the status nor the
      // code is evidence of which one occurred. Report both; infer neither.
      if (!started && (item.status === "failed" || item.status === "declined")) {
        state.nonSuccessfulItems.push(describeNonSuccessfulItem(item));
      }
      if (item.type === "command_execution") {
        const cmd = String(item.command || item.command_line || "").slice(0, 120);
        if (started) {
          state.lastCommand = cmd || null;
          emit(cmd ? `running: ${cmd}` : "running command");
        } else {
          state.lastCommand = null;
        }
      } else if (item.type === "file_change") {
        // Collected from both events: either one alone may carry the full list.
        for (const p of pathsFromFileChangeItem(item)) {
          if (state.reportedPaths.has(p)) continue;
          if (state.reportedPaths.size >= MAX_REPORTED_PATHS) {
            // A flag, not a tally. Codex announces the same item twice, so counting
            // each over-cap path as it arrives reported one omission per
            // announcement; remembering them to count once would defeat the cap.
            state.pathsTruncated = true;
            continue;
          }
          state.reportedPaths.add(p);
        }
        if (started) {
          const n = Array.isArray(item.changes) ? item.changes.length : 0;
          emit(n ? `editing ${n} file(s)` : "editing files");
        }
      } else if (item.type === "web_search") {
        emit("web search");
      }
    }
  };

  return { state, handleLine };
}

/**
 * A rolling tail, not the first 64 KB: the diagnosis is the last thing a dying
 * process writes, and stderrTail then takes the tail of whatever this kept. Keep
 * the head and a megabyte of noise buries the one line that says why.
 */
function createStderrTail(maxBytes) {
  const chunks = [];
  let bytes = 0;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!buffer.length) return;
      chunks.push(buffer);
      bytes += buffer.length;
      while (bytes > maxBytes) {
        const excess = bytes - maxBytes;
        const oldest = chunks[0];
        if (oldest.length <= excess) {
          chunks.shift();
          bytes -= oldest.length;
        } else {
          chunks[0] = oldest.subarray(excess);
          bytes -= excess;
        }
      }
    },
    get bytes() {
      return bytes;
    },
    text() {
      return Buffer.concat(chunks, bytes).toString("utf8");
    },
  };
}

/**
 * One outcome, one reason. `reason` replaces the timedOut/cancelled booleans:
 * it says which of the several ways to not finish actually happened.
 */
function classifyOutcome({ interrupted, timedOut, timeoutReason, turnStatus, exitCode }) {
  if (interrupted) {
    return { status: "interrupted", reason: timedOut ? timeoutReason : "cancelled" };
  }
  if (turnStatus === "failed") return { status: "failed", reason: "agent-error" };
  // Process died mid-turn: do not treat a partial --output-last-message as final.
  if (exitCode === 0 && turnStatus === "in_progress") {
    return { status: "failed", reason: "died-mid-turn" };
  }
  // Some review paths exit cleanly without turn events; still require exit 0.
  if (exitCode === 0 && (turnStatus === "completed" || turnStatus === "running")) {
    return { status: "completed", reason: undefined };
  }
  return { status: "failed", reason: "exit-nonzero" };
}

/** Every warning the run itself can raise, in the order the caller reads them. */
function buildRunWarnings({
  agentError,
  resultWarnings,
  timedOut,
  timeoutReason,
  startupMs,
  hardCapMs,
  unusableThreadIdChars,
  pathsTruncated,
  nonSuccessfulItems,
  killEscaped,
  killDeadlineMs,
  drainEscaped,
  drainMs,
  status,
  stderrTail,
}) {
  const warnings = [];
  if (agentError) warnings.push(`Codex error: ${agentError}`);
  warnings.push(...resultWarnings);
  if (timedOut && timeoutReason === "startup-timeout") {
    warnings.push(
      `Codex produced no output within ${startupMs}ms of spawning. Run doctor to check the CLI resolves and is logged in; raise CODEX_DELEGATE_STARTUP_MS on a slow machine.`
    );
  } else if (timedOut && timeoutReason === "hard-cap") {
    warnings.push(`Hard-cap timeout after ${hardCapMs}ms. Raise timeoutMs for longer tasks.`);
  }
  if (unusableThreadIdChars) {
    warnings.push(
      `Codex reported a ${unusableThreadIdChars}-character thread id, past the ${MAX_THREAD_ID_CHARS} character limit; it was dropped, so this run cannot be resumed.`
    );
  }
  if (pathsTruncated) {
    warnings.push(
      `Codex reported more than ${MAX_REPORTED_PATHS} edited files; the list stops there and the rest are missing from it. Read the git diff for the full set.`
    );
  }
  // Only on a run that broke. Routing around a failed command is the agent doing its
  // job, and it reports the ones it cannot route around; surfacing every discarded
  // attempt fired on most healthy runs and taught the caller to skim this array —
  // which also carries the capacity errors and truncated results.
  if (nonSuccessfulItems.length && status !== "completed") {
    const shown = nonSuccessfulItems.slice(0, 3).join("; ");
    const more =
      nonSuccessfulItems.length > 3 ? ` (+${nonSuccessfulItems.length - 3} more)` : "";
    warnings.push(
      `${nonSuccessfulItems.length} Codex tool call(s) reported failed or declined during this turn: ${shown}${more}. declined: the command never ran, so its effect is absent. failed: it ran and exited non-zero — normal for a red suite, and the status does not identify a cause.`
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
  if (status !== "completed" && stderrTail.trim()) {
    warnings.push(`stderr: ${stderrTail.trim()}`);
  }
  return warnings;
}

/**
 * Trim to a UTF-8 byte budget, backing off to a codepoint boundary so the cut
 * cannot emit a replacement character. Discarding an oversized result would throw
 * the answer away to punish its length; the front of it plus a warning tells the
 * caller both what was said and that it was cut.
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

async function readCappedFile(filePath, maxResultBytes, openFileImpl) {
  const file = await openFileImpl(filePath, "r");
  try {
    if (!(Number.isSafeInteger(maxResultBytes) && maxResultBytes > 0)) {
      return capResultBytes(await file.readFile({ encoding: "utf8" }), maxResultBytes);
    }

    const stats = await file.stat();
    const fileBytes = Number.isFinite(stats?.size) && stats.size >= 0 ? stats.size : 0;
    // Four look-ahead bytes are enough to finish any UTF-8 codepoint that crosses
    // the cap, without allowing the read itself to grow with an oversized file.
    const readLimit = Math.min(maxResultBytes + 4, fileBytes);
    const buffer = Buffer.alloc(readLimit);
    let bytesRead = 0;
    while (bytesRead < readLimit) {
      const chunk = await file.read(buffer, bytesRead, readLimit - bytesRead, bytesRead);
      if (!(chunk.bytesRead > 0)) break;
      bytesRead += chunk.bytesRead;
    }

    const capped = capResultBytes(buffer.subarray(0, bytesRead).toString("utf8"), maxResultBytes);
    if (fileBytes > maxResultBytes) {
      capped.warnings = [
        `Result was ${fileBytes} bytes, truncated to the ${maxResultBytes} byte cap.`,
      ];
    }
    return capped;
  } finally {
    await file.close();
  }
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
  if (!kept.length) return null;
  // `codex exec review` reports every count as 0 on turns that plainly spent
  // tokens. A field that is present and always meaningless is worse than absent.
  if (kept.every(([, v]) => v === 0)) return null;
  return Object.fromEntries(kept);
}

export function describeNonSuccessfulItem(item, maxChars = 200) {
  const kind = String(item?.type || "item");
  // Codex reports a multi-line script verbatim, and a warning is read as one line.
  const detail = String(item?.command || item?.command_line || "")
    .replace(/\s+/g, " ")
    .trim();
  const status = item?.status ? ` ${item.status}` : "";
  const exit = Number.isInteger(item?.exit_code) ? ` exit ${item.exit_code}` : "";
  // A cut lands mid-token and reads as a syntax error unless it says it was cut.
  // The marker sits outside the quotes so it cannot be mistaken for the command.
  const cut = detail.length > maxChars ? " (truncated)" : "";
  const label = detail ? `${kind} "${detail.slice(0, maxChars)}"${cut}` : kind;
  return `${label}${status}${exit}`;
}

/** Codex has printed this while reading a piped prompt; it is not a diagnosis. */
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

/**
 * @param {{
 *   filePath?: string,
 *   status?: string,
 *   exitCode?: number | null,
 *   maxResultBytes?: number,
 *   openFileImpl?: typeof openFile,
 * }} [options]
 */
export async function readFinalResult({
  filePath,
  status,
  exitCode,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  openFileImpl = openFile,
} = {}) {
  if (status !== "completed" || exitCode !== 0) {
    return {
      result: "",
      finalMessageAvailable: false,
      warnings: [],
    };
  }
  try {
    const capped = await readCappedFile(filePath, maxResultBytes, openFileImpl);
    return { result: capped.text, finalMessageAvailable: true, warnings: capped.warnings };
  } catch {
    // The run layer reports this as reason "result-unavailable"; a warning
    // repeating the reason is noise.
    return {
      result: "",
      finalMessageAvailable: false,
      warnings: [],
    };
  }
}
