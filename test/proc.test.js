import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "./fixtures/temp-dir.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isChildAlive, treeKill } from "../src/proc.js";

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
    { target: -NO_PID, signal: "SIGSTOP" },
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

/** Run `fn` with a `ps` on PATH that runs `body` (sh) in place of the real one at `$REAL_PS`. */
async function withPs(body, fn) {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "cdm-ps-"));
  const realPs = execFileSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "ps"), `#!/bin/sh\nREAL_PS=${realPs}\n${body}\n`);
  chmodSync(join(dir, "ps"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

test("a session a command in its own session starts while the tree is listed is killed too", posixOnly, async () => {
  const { child, grandchildPid } = await startTree("own-session-trigger");
  const pidFile = child.spawnargs[2];
  let latePid;
  try {
    await withPs(`out=$("$REAL_PS" "$@")\ntouch "${pidFile}.trigger"\nsleep 0.5\nprintf '%s\\n' "$out"`, () =>
      treeKill(child.pid, { childAlive: true })
    );
    await until(() => existsSync(`${pidFile}.late`), 5_000, "the grandchild never started its session");
    latePid = Number(readFileSync(`${pidFile}.late`, "utf8").trim());
    await until(() => !pidAlive(latePid), 5_000, "a session started during the listing survived the kill");
  } finally {
    for (const pid of [child.pid, grandchildPid, latePid]) {
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
});

test("a command Codex starts while its tree is listed is killed too", posixOnly, async () => {
  const { child, grandchildPid } = await startTree("spawn-on-trigger");
  const pidFile = child.spawnargs[2];
  let latePid;
  try {
    // The listing is taken before the trigger, so a command started on it is not in the listing.
    await withPs(`out=$("$REAL_PS" "$@")\ntouch "${pidFile}.trigger"\nsleep 0.5\nprintf '%s\\n' "$out"`, () =>
      treeKill(child.pid, { childAlive: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (existsSync(`${pidFile}.late`)) {
      latePid = Number(readFileSync(`${pidFile}.late`, "utf8").trim());
      await until(() => !pidAlive(latePid), 5_000, "a command started during the listing survived the kill");
    }
  } finally {
    for (const pid of [grandchildPid, latePid]) {
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
});

test("a ps that ignores SIGTERM does not hold the kill past its timeout", posixOnly, async () => {
  const { child, grandchildPid } = await startTree("lingers");
  try {
    const startedAt = Date.now();
    await withPs("trap '' TERM\nexec sleep 30", () => treeKill(child.pid, { childAlive: true }));
    assert.ok(Date.now() - startedAt < 10_000, `the kill waited ${Date.now() - startedAt}ms on ps`);
    await until(() => !isChildAlive(child), 10_000, "leader survived the kill");
  } finally {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {}
  }
});

test("the descendant walk does not depend on the user's ps personality", posixOnly, async () => {
  const { child, grandchildPid } = await startTree("own-session");
  const personality = process.env.PS_PERSONALITY;
  process.env.PS_PERSONALITY = "bsd";
  try {
    await treeKill(child.pid, { childAlive: true });
    await until(() => !pidAlive(grandchildPid), 10_000, "grandchild survived the kill");
  } finally {
    if (personality === undefined) delete process.env.PS_PERSONALITY;
    else process.env.PS_PERSONALITY = personality;
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {}
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
