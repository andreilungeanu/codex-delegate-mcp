import process from "node:process";
import { execFile, execFileSync } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

/**
 * Every process below pid, from one `ps` snapshot (Linux and macOS both take -A -o pid=,ppid=).
 * Synchronous, so a kill is still dispatched before the caller's first await. Empty when ps
 * fails: the group kill still runs.
 */
function descendantPids(pid) {
  // procps refuses -A under a BSD personality.
  const { PS_PERSONALITY, CMD_ENV, ...env } = process.env;
  let stdout;
  try {
    stdout = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      env,
      // SIGKILL: a ps wrapper can ignore SIGTERM, and this blocks the loop until it exits.
      timeout: 3000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  /** @type {Map<number, number[]>} */
  const byParent = new Map();
  for (const line of stdout.split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || !Number.isFinite(pp)) continue;
    if (!byParent.has(pp)) byParent.set(pp, []);
    byParent.get(pp)?.push(p);
  }
  const out = [];
  const queue = [pid];
  while (queue.length) {
    for (const c of byParent.get(/** @type {number} */ (queue.shift())) ?? []) {
      if (!out.includes(c)) {
        out.push(c);
        queue.push(c);
      }
    }
  }
  return out;
}

/**
 * Kill the process tree. On Windows plain kill() only hits a shell wrapper.
 *
 * `childAlive` gates every kill aimed at the bare pid: once reaped it can be
 * recycled, and the signal would land on somebody else's process. On POSIX the
 * group kill still runs either way — a group outlives its leader, so Codex can be
 * gone while the commands it started are still in it, and the group is the only
 * handle left on them.
 *
 * Windows has no such handle. `taskkill /T` walks parent links, which an exited
 * leader no longer has, and what it left behind is either already gone with it or
 * detached and out of reach. So there is nothing for a post-exit kill to reach and
 * a recycled pid for it to hit: the gate is the whole of it.
 */
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    if (!childAlive) return;
    await /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () =>
          resolve()
        );
      })
    );
    return;
  }
  // Codex starts each shell command in a session of its own (measured on Linux, CLI 0.170), out
  // of the group's reach, so the tree is walked while Codex is alive to hold its parent links.
  // Stopped first, so Codex starts no command the listing would miss.
  if (childAlive) {
    try {
      process.kill(-pid, "SIGSTOP");
    } catch {}
  }
  const descendants = childAlive ? descendantPids(pid) : [];
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (childAlive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  for (const d of descendants) {
    try {
      process.kill(-d, "SIGKILL");
    } catch {}
    try {
      process.kill(d, "SIGKILL");
    } catch {}
  }
}
