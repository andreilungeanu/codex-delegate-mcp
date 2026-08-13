import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { isChildAlive, treeKill } from "../src/proc.js";

const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups" : false };

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
  const calls = await recordKills(4242, { childAlive: false });
  assert.deepEqual(calls, [{ target: -4242, signal: "SIGKILL" }]);
});

test("the bare pid is only signalled while the child is alive", posixOnly, async () => {
  // A reaped pid can be recycled, so the fallback must not fire once the child is
  // gone — that signal would land on somebody else's process.
  const calls = await recordKills(4242, { childAlive: true });
  assert.deepEqual(calls, [
    { target: -4242, signal: "SIGKILL" },
    { target: 4242, signal: "SIGKILL" },
  ]);
});

test("treeKill does nothing without a pid", async () => {
  assert.deepEqual(await recordKills(undefined, { childAlive: true }), []);
});
