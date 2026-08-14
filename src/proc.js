import process from "node:process";
import { execFile } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
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
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (!childAlive) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
