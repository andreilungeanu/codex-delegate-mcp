import process from "node:process";
import { execFile } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

/**
 * Kill the process tree. On Windows plain kill() only hits a shell wrapper.
 *
 * `childAlive` gates the single-pid fallback alone. The group kill always runs: a
 * POSIX group outlives its leader, so Codex can be gone while the commands it
 * started are still in that group, and the group is the only handle left on them.
 * The bare pid is the one that must stay gated — once reaped it can be recycled,
 * and SIGKILL would land on somebody else's process.
 */
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    await /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () =>
          resolve()
        );
      })
    );
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (!childAlive) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
