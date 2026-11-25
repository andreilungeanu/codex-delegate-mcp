import { spawn } from "node:child_process";
import { stopChild } from "./proc.js";
import { VERSION } from "./version.js";

/** A window at or above this share of its limit is raised as a warning. */
export const USAGE_WARN_PERCENT = 80;

/**
 * `account/rateLimits/read` from `codex app-server`: no model call. app-server is experimental
 * in Codex's help, so anything but a well-formed answer is null. It exits once stdin closes
 * (measured ~10ms, CLI 0.171.0); the kill is for one that never answers.
 *
 * @param {{ command?: string | null, commandArgs?: string[], timeoutMs?: number, spawnImpl?: typeof spawn }} options
 * @returns {Promise<any | null>}
 */
export async function readRateLimits({ command, commandArgs = [], timeoutMs = 10_000, spawnImpl = spawn }) {
  if (!command) return null;
  let child;
  try {
    child = spawnImpl(command, [...commandArgs, "app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      resolve(value);
    };
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); } catch {}
    };
    const timer = setTimeout(() => {
      finish(null);
      stopChild(child).catch(() => {});
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(null);
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          finish(message.error ? null : message.result ?? null);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-delegate-mcp", version: VERSION } } });
  });
}

/** 300 → "5h", 10080 → "7d". */
function windowLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function readWindow(raw) {
  if (!raw || typeof raw.usedPercent !== "number" || typeof raw.windowDurationMins !== "number") return null;
  return {
    window: windowLabel(raw.windowDurationMins),
    usedPercent: raw.usedPercent,
    ...(typeof raw.resetsAt === "number" ? { resetsAt: new Date(raw.resetsAt * 1000).toISOString() } : {}),
  };
}

/**
 * The plan, each window, and only the fields that say something is off. Warns on a reached
 * limit or a window at USAGE_WARN_PERCENT or above.
 *
 * @param {any} raw
 * @param {string[]} warnings
 */
export function describeUsage(raw, warnings) {
  const limits = raw?.rateLimits;
  if (!limits || typeof limits !== "object") return null;
  const windows = [limits.primary, limits.secondary].map(readWindow).filter(Boolean);
  const reached = limits.rateLimitReachedType ?? (raw.ordinaryUsageAllowed === false ? "usage" : null);
  if (reached) {
    const resets = windows.filter((w) => w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt);
    warnings.push(
      `Codex reports its ${reached} limit reached; delegations fail until it resets${resets.length ? ` (${resets.join(", ")})` : ""}.`
    );
  } else {
    for (const w of windows) {
      if (w.usedPercent >= USAGE_WARN_PERCENT) {
        warnings.push(`Codex ${w.window} usage is at ${w.usedPercent}%${w.resetsAt ? `; it resets at ${w.resetsAt}` : ""}.`);
      }
    }
  }
  const resetCredits = raw.rateLimitResetCredits?.availableCount;
  return {
    ...(typeof limits.planType === "string" ? { plan: limits.planType } : {}),
    windows,
    ...(reached ? { limitReached: reached } : {}),
    ...(limits.credits?.hasCredits ? { credits: limits.credits.unlimited ? "unlimited" : limits.credits.balance } : {}),
    ...(typeof resetCredits === "number" && resetCredits > 0 ? { resetCredits } : {}),
  };
}
