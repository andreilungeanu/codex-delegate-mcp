import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "./fixtures/temp-dir.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KILL_WAIT_MS, isChildAlive, stopChild, treeKill } from "../src/proc.js";

const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups" : false };
// Above any pid_max, so the descendant walk finds no child of it.
const NO_PID = 4_194_305;

/** Record what treeKill signals, without signalling anything. */
async function recordKills(pid, options) {
  const realKill = process.kill;
  const calls = [];
  process.kill = (target, signal) => {
    calls.push({ target, signal });
    // The group kill failing is what reaches the single-pid fallback.
    if (target < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  try {
    await treeKill(pid, options);
  } finally {
    process.kill = realKill;
  }
  return calls;
}

test("isChildAlive is false once the child has exited", () => {
  assert.equal(isChildAlive({ exitCode: null, signalCode: null }), true);
  assert.equal(isChildAlive({ exitCode: 0, signalCode: null }), false);
  assert.equal(isChildAlive({ exitCode: null, signalCode: "SIGKILL" }), false);
  assert.equal(isChildAlive(null), null);
});

test("the group is signalled even after the leader has exited", posixOnly, async () => {
  // The whole point of detaching: a POSIX group outlives its leader, so Codex can be
  // gone while the commands it started are still in the group.
  const calls = await recordKills(NO_PID, { childAlive: false });
  assert.deepEqual(calls, [{ target: -NO_PID, signal: "SIGKILL" }]);
});

test("the bare pid is only signalled while the child is alive", posixOnly, async () => {
  // A reaped pid can be recycled, so the fallback must not fire once the child is
  // gone — that signal would land on somebody else's process.
  const calls = await recordKills(NO_PID, { childAlive: true });
  assert.deepEqual(calls, [
    { target: -NO_PID, signal: "SIGKILL" },
    { target: NO_PID, signal: "SIGKILL" },
  ]);
});

test("treeKill does nothing without a pid", async () => {
  assert.deepEqual(await recordKills(undefined, { childAlive: true }), []);
});

// ---------------------------------------------------------------------------
// Real processes. Everything above records call shape; none of it would notice
// that `detached` was dropped from the spawn, that `taskkill` lost `/T`, or that
// the kill never reached the OS at all.
// ---------------------------------------------------------------------------

const FIXTURE = fileURLToPath(new URL("./fixtures/spawns-grandchild.mjs", import.meta.url));

/**
 * A pid that has exited but not been waited on is still a valid signal target. Under
 * a container the test process can be pid 1 and reap nothing, so `kill(pid, 0)`
 * succeeding is not proof of life — read the state instead where /proc exists.
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === "EPERM";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return true;
  }
}

async function until(predicate, ms, message) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

/** Start the fixture and wait until it reports the grandchild it spawned. */
async function startTree(mode) {
  const dir = await mkdtemp(join(tmpdir(), "cdm-tree-"));
  const pidFile = join(dir, "grandchild.pid");
  const child = spawn(process.execPath, [FIXTURE, pidFile, mode], {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").includes("\n"), 10_000,
    "fixture never reported a grandchild pid");
  const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(pidAlive(grandchildPid), "grandchild must be alive before the kill");
  return { child, grandchildPid, exited };
}

// POSIX-only, and not for lack of a Windows equivalent to write: on Windows a
// spawned tree is torn down with the process that started it, so this scenario does
// not survive long enough to kill — measured, not assumed. `taskkill /T` also walks
// parent links, which a dead leader no longer has. The group is what makes the
// orphan reachable, and the group is POSIX.
test("the kill reaches a grandchild whose leader has already exited", posixOnly, async () => {
  const { child, grandchildPid, exited } = await startTree("leader-exits");
  try {
    // The orphan case: Codex is gone, the command it started is not. Gating the kill
    // on the direct child being alive is exactly what used to skip this.
    await exited;
    assert.equal(isChildAlive(child), false, "leader must be gone before the kill");
    await treeKill(child.pid, { childAlive: false });
    await until(() => !pidAlive(grandchildPid), 10_000, "grandchild survived the kill");
  } finally {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {}
  }
});

test("the kill reaches a grandchild while the leader is still running", async () => {
  const { child, grandchildPid } = await startTree("lingers");
  try {
    await treeKill(child.pid, { childAlive: true });
    await until(() => !pidAlive(grandchildPid), 10_000, "grandchild survived the kill");
    await until(() => !isChildAlive(child), 10_000, "leader survived the kill");
  } finally {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {}
  }
});

test("the kill reaches a grandchild in a session of its own, and the command it runs", posixOnly, async () => {
  const { child, grandchildPid } = await startTree("own-session");
  const nestedFile = `${child.spawnargs[2]}.nested`;
  await until(() => existsSync(nestedFile) && readFileSync(nestedFile, "utf8").includes("\n"), 10_000,
    "the grandchild never reported its command");
  const nestedPid = Number(readFileSync(nestedFile, "utf8").trim());
  try {
    await treeKill(child.pid, { childAlive: true });
    await until(() => !pidAlive(grandchildPid), 10_000, "grandchild survived the kill");
    await until(() => !pidAlive(nestedPid), 10_000, "the grandchild's command survived the kill");
    await until(() => !isChildAlive(child), 10_000, "leader survived the kill");
  } finally {
    for (const pid of [child.pid, grandchildPid, nestedPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
});

const win32Only = { skip: process.platform === "win32" ? false : "windows taskkill" };

// POSIX gates the bare-pid kill on childAlive because a reaped pid can be recycled.
// taskkill has no group to aim at, so the bare pid is all it ever has — which makes
// the gate matter more on Windows, not less.
test("the windows kill does not fire once the child has exited", win32Only, async () => {
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const alive = () => {
    try {
      process.kill(victim.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(alive(), "the stand-in for a recycled pid must be running");

    await treeKill(victim.pid, { childAlive: false });
    await new Promise((r) => setTimeout(r, 900));

    assert.equal(alive(), true, "treeKill killed a pid it was told was no longer the child");
  } finally {
    try {
      victim.kill();
    } catch {}
  }
});

test("the windows kill still fires while the child is alive", win32Only, async () => {
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const alive = () => {
    try {
      process.kill(victim.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(alive(), "the victim must be running before the kill");

    await treeKill(victim.pid, { childAlive: true });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 50));

    assert.equal(alive(), false, "the gate swallowed a kill that should have landed");
  } finally {
    try {
      victim.kill();
    } catch {}
  }
});

// taskkill replaced by a real process running script, which kills nothing.
function swapTaskkill(script) {
  const cp = createRequire(import.meta.url)("node:child_process");
  const real = cp.execFile;
  const utilities = [];
  cp.execFile = (file, args, opts, cb) => {
    if (file !== "taskkill") return real(file, args, opts, cb);
    const utility = real(process.execPath, ["-e", script], opts, cb);
    utilities.push(utility);
    return utility;
  };
  syncBuiltinESMExports();
  return {
    utilities,
    restore: () => {
      cp.execFile = real;
      syncBuiltinESMExports();
      for (const u of utilities) {
        try {
          u.kill("SIGKILL");
        } catch {}
      }
    },
  };
}

test("treeKill reports a taskkill that failed, and one that found no such process as done", win32Only, async () => {
  for (const [code, expected] of [[1, false], [128, true]]) {
    const swap = swapTaskkill(`process.exit(${code})`);
    try {
      assert.equal(await treeKill(4242, { childAlive: true }), expected, `taskkill exit ${code}`);
    } finally {
      swap.restore();
    }
  }
});

const startChild = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

test("stopChild kills a running child once, and every caller gets that stop", async () => {
  const child = startChild();
  await new Promise((r) => child.once("spawn", r));
  const first = stopChild(child);
  assert.equal(stopChild(child), first);
  assert.equal(await first, true);
  assert.equal(isChildAlive(child), false);
});

// The launcher dies by its handle, but what it started is out of reach, so the stop is unconfirmed.
test("a taskkill that fails still ends the child, by its own handle, and the stop is unconfirmed", win32Only, async () => {
  const swap = swapTaskkill("process.exit(1)");
  const child = startChild();
  try {
    assert.equal(await stopChild(child), false, "a failed taskkill was taken for a clean stop");
    assert.equal(isChildAlive(child), false, "the child outlived the stop");
  } finally {
    swap.restore();
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

test("a taskkill that stalls is stopped at its bound, and the child killed by its own handle", win32Only, async () => {
  const swap = swapTaskkill("setInterval(() => {}, 1000)");
  const child = startChild();
  const started = Date.now();
  try {
    assert.equal(await stopChild(child), false, "a stalled taskkill was taken for a clean stop");
    assert.equal(isChildAlive(child), false, "the child outlived the stop");
    assert.ok(Date.now() - started < KILL_WAIT_MS + 2000, `the stop took ${Date.now() - started} ms`);
    const [utility] = swap.utilities;
    assert.notEqual(utility.signalCode ?? utility.exitCode, null, "the stalled taskkill is still running");
  } finally {
    swap.restore();
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});
