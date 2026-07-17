import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, unlink } from "node:fs/promises";
import { isChildAlive, treeKill } from "./proc.js";

const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;

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
  timeoutMs = 900_000,
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
  let cancelled = false;
  let threadId = null;
  let turnStatus = "running";
  let stderr = "";

  const childEnv = { ...env };
  // Recursion marker for nested delegate detection by the parent server.
  childEnv.CODEX_DELEGATE_DEPTH = "1";

  try {
    await unlink(resultFile).catch(() => {});
  } catch {}

  const spawnOpts = {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  };
  if (platform !== "win32") spawnOpts.detached = true;

  child = spawnImpl(command, args, spawnOpts);

  const abort = async ({ userCancel = false } = {}) => {
    if (userCancel) cancelled = true;
    if (isChildAlive(child)) await treeKillImpl(child.pid);
  };

  const onAbort = () => {
    abort({ userCancel: true }).catch(() => {});
  };
  if (signal) {
    if (signal.aborted) await abort({ userCancel: true });
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let timer;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      abort({ userCancel: false }).catch(() => {});
    }, timeoutMs);
    timer.unref?.();
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
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
      try {
        onProgress?.("thread started");
      } catch {}
    } else if (event?.type === "turn.started") {
      turnStatus = "in_progress";
      try {
        onProgress?.("turn started");
      } catch {}
    } else if (event?.type === "turn.completed") {
      turnStatus = "completed";
      try {
        onProgress?.("turn completed");
      } catch {}
    } else if (event?.type === "turn.failed") {
      turnStatus = "failed";
      try {
        onProgress?.("turn failed");
      } catch {}
    } else if (event?.type === "item.started" || event?.type === "item.completed") {
      const item = event.item;
      if (!item) return;
      if (item.type === "command_execution") {
        const cmd = String(item.command || item.command_line || "").slice(0, 120);
        try {
          onProgress?.(cmd ? `running: ${cmd}` : "running command");
        } catch {}
      } else if (item.type === "file_change") {
        const n = Array.isArray(item.changes) ? item.changes.length : 0;
        try {
          onProgress?.(n ? `editing ${n} file(s)` : "editing files");
        } catch {}
      } else if (item.type === "web_search") {
        try {
          onProgress?.("web search");
        } catch {}
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    if (stderr.length >= DEFAULT_STDERR_BYTES) return;
    stderr += chunk.toString("utf8");
    if (stderr.length > DEFAULT_STDERR_BYTES) stderr = stderr.slice(0, DEFAULT_STDERR_BYTES);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  clearTimeout(timer);
  if (signal) signal.removeEventListener("abort", onAbort);
  rl.close();

  const interrupted = cancelled || timedOut || signal?.aborted;
  let status = "failed";
  if (interrupted) status = "interrupted";
  else if (turnStatus === "failed") status = "failed";
  else if (exitCode === 0 && turnStatus === "completed") status = "completed";
  else if (exitCode === 0 && turnStatus === "running") {
    // Some review paths exit cleanly without turn events; still require exit 0.
    status = "completed";
  } else if (exitCode === 0 && turnStatus === "in_progress") {
    // Process died mid-turn: do not treat a partial --output-last-message as final.
    status = "failed";
  } else if (exitCode === 0) status = "completed";
  else status = "failed";

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
    cancelled,
    result: final.result,
    finalMessageAvailable: final.finalMessageAvailable,
    warnings: final.warnings,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
  };
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
