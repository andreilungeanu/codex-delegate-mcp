import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createOperationRegistry } from "../src/ops.js";

test("delegations are not rationed", () => {
  const reg = createOperationRegistry();
  const leases = Array.from({ length: 25 }, () => reg.acquire({ cancel: async () => {} }));
  assert.equal(reg.snapshot().count, 25);
  for (const lease of leases) lease.release();
  assert.deepEqual(reg.snapshot(), { active: false });
});

test("every delegation gets a distinct id, available before it runs", () => {
  const reg = createOperationRegistry();
  const a = reg.acquire({ cancel: async () => {} });
  const b = reg.acquire({ cancel: async () => {} });
  assert.ok(a.delegationId);
  assert.notEqual(a.delegationId, b.delegationId);
  a.release();
  b.release();
});

test("cancel returns nothing-active when idle", async () => {
  const reg = createOperationRegistry();
  const result = await reg.cancel({});
  assert.equal(result.status, "nothing-active");
});

test("cancel by threadId invokes that delegation's cancel", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const lease = reg.acquire({
    threadId: "t1",
    cancel: async () => {
      hits += 1;
    },
  });
  const result = await reg.cancel({ threadId: "t1" });
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 1);
  assert.equal(lease.getCancellation()?.status, "cancelled");
  lease.release();
});

test("cancel by delegationId works before any thread id exists", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const lease = reg.acquire({
    cancel: async () => {
      hits += 1;
    },
  });
  const result = await reg.cancel({ id: lease.delegationId });
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 1);
  lease.release();
});

test("cancel leaves the other delegations running", async () => {
  const reg = createOperationRegistry();
  let killedA = 0;
  let killedB = 0;
  const a = reg.acquire({
    threadId: "thread-a",
    cancel: async () => {
      killedA += 1;
    },
  });
  const b = reg.acquire({
    threadId: "thread-b",
    cancel: async () => {
      killedB += 1;
    },
  });

  const result = await reg.cancel({ id: "thread-a" });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.cancelled, [{ delegationId: a.delegationId, threadId: "thread-a" }]);
  assert.equal(killedA, 1);
  assert.equal(killedB, 0);
  assert.equal(b.getCancellation(), null);
  a.release();
  b.release();
});

test("cancel with no id cancels every active delegation", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const a = reg.acquire({ cancel: async () => void hits++ });
  const b = reg.acquire({ cancel: async () => void hits++ });

  const result = await reg.cancel({});
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 2);
  assert.equal(result.cancelled.length, 2);
  a.release();
  b.release();
});

test("cancel all waits for every selected delegation before reporting a failure", async () => {
  const reg = createOperationRegistry();
  let releaseSlowCancel;
  let slowCancelSettled = false;
  let cancelReturned = false;
  const slowCancel = new Promise((resolve) => {
    releaseSlowCancel = resolve;
  });

  const failed = reg.acquire({
    cancel: async () => {
      throw new Error("first kill failed");
    },
  });
  const slow = reg.acquire({
    cancel: async () => {
      await slowCancel;
      slowCancelSettled = true;
    },
  });

  const pending = reg.cancel({}).catch((err) => err);
  pending.finally(() => {
    cancelReturned = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const returnedBeforeSlowCancel = cancelReturned;
  releaseSlowCancel();

  const error = await pending;
  assert.equal(returnedBeforeSlowCancel, false);
  assert.equal(slowCancelSettled, true);
  assert.match(error.message, /first kill failed/);
  failed.release();
  slow.release();
});

/**
 * A resume shares its thread id with the turn it resumes. Both are live and both
 * are cancellable; storing one delegation per thread id would let whichever
 * finished first deregister the other, after which cancel reports a running
 * delegation as already gone.
 */
test("a thread id shared by two delegations cancels both", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const first = reg.acquire({ threadId: "shared", cancel: async () => void hits++ });
  const second = reg.acquire({ threadId: "shared", cancel: async () => void hits++ });

  const result = await reg.cancel({ id: "shared" });
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 2);
  assert.equal(result.cancelled.length, 2);
  first.release();
  second.release();
});

test("cancel by shared thread waits for every selected delegation before failing", async () => {
  const reg = createOperationRegistry();
  let releaseSlowCancel;
  let slowCancelSettled = false;
  let cancelReturned = false;
  const slowCancel = new Promise((resolve) => {
    releaseSlowCancel = resolve;
  });

  const failed = reg.acquire({
    threadId: "shared-failure",
    cancel: async () => {
      throw new Error("shared kill failed");
    },
  });
  const slow = reg.acquire({
    threadId: "shared-failure",
    cancel: async () => {
      await slowCancel;
      slowCancelSettled = true;
    },
  });

  const pending = reg.cancel({ id: "shared-failure" }).catch((err) => err);
  pending.finally(() => {
    cancelReturned = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const returnedBeforeSlowCancel = cancelReturned;
  releaseSlowCancel();

  const error = await pending;
  assert.equal(returnedBeforeSlowCancel, false);
  assert.equal(slowCancelSettled, true);
  assert.match(error.message, /shared kill failed/);
  failed.release();
  slow.release();
});

test("releasing one of two delegations on a thread leaves the other cancellable", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const first = reg.acquire({ threadId: "shared", cancel: async () => void hits++ });
  const second = reg.acquire({ threadId: "shared", cancel: async () => void hits++ });

  first.release();
  const result = await reg.cancel({ id: "shared" });
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 1);
  assert.deepEqual(result.cancelled, [{ delegationId: second.delegationId, threadId: "shared" }]);
  second.release();
});

test("a thread that finished is not-running; an id never seen is not-found", async () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({ threadId: "done", cancel: async () => {} });
  lease.release();

  assert.equal((await reg.cancel({ id: "done" })).status, "not-running");
  assert.equal((await reg.cancel({ id: "never-existed" })).status, "not-found");
});

test("a thread id learned mid-run becomes cancellable", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const lease = reg.acquire({ cancel: async () => void hits++ });
  assert.equal((await reg.cancel({ id: "late-tid" })).status, "not-found");

  lease.updateThreadId("late-tid");
  const result = await reg.cancel({ id: "late-tid" });
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 1);
  lease.release();
});

test("double cancel shares one cancel invocation", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const lease = reg.acquire({
    threadId: "t-double",
    cancel: async () => {
      hits += 1;
      await gate;
    },
  });

  const first = reg.cancel({ threadId: "t-double" });
  const second = reg.cancel({ threadId: "t-double" });
  assert.equal(lease.getCancellation()?.status, "cancelling");
  releaseGate();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "cancelled");
  assert.equal(b.status, "cancelled");
  assert.equal(hits, 1);
  lease.release();
});

test("a cancel that throws is reported on the delegation and rethrown", async () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({
    threadId: "boom",
    cancel: async () => {
      throw new Error("kill failed");
    },
  });
  await assert.rejects(reg.cancel({ id: "boom" }), /kill failed/);
  assert.equal(lease.getCancellation()?.status, "failed");
  assert.match(lease.getCancellation()?.message, /kill failed/);
  lease.release();
});

test("snapshot reports the active delegations", async () => {
  const reg = createOperationRegistry();
  assert.deepEqual(reg.snapshot(), { active: false });

  const lease = reg.acquire({ threadId: "in-flight", cancel: async () => {} });
  const snap = reg.snapshot();
  assert.equal(snap.active, true);
  assert.equal(snap.count, 1);
  assert.equal(snap.delegations[0].threadId, "in-flight");
  assert.equal(snap.delegations[0].cancellation, null);

  await reg.cancel({ cause: "user" });
  assert.equal(reg.snapshot().delegations[0].cancellation.status, "cancelled");
  assert.equal(lease.getCancellation()?.cause, "user");
  lease.release();
  assert.deepEqual(reg.snapshot(), { active: false });
});

test("releasing twice does not disturb a delegation that reused the thread id", () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({ threadId: "recycled", cancel: async () => {} });
  lease.release();
  lease.release();
  const next = reg.acquire({ threadId: "recycled", cancel: async () => {} });
  assert.equal(reg.snapshot().count, 1);
  next.release();
});

test("a thread id set after release does not resurrect the delegation", async () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({ cancel: async () => {} });
  lease.release();
  lease.updateThreadId("after-the-fact");
  assert.equal((await reg.cancel({ id: "after-the-fact" })).status, "not-found");
  assert.deepEqual(reg.snapshot(), { active: false });
});

test("an overlapping workspace warns, a disjoint one does not", () => {
  const reg = createOperationRegistry();
  const root = path.resolve("/tmp/overlap-root");
  const first = reg.acquire({ workspace: root, cancel: async () => {} });
  assert.deepEqual(first.warnings, []);

  const nested = reg.acquire({ workspace: path.join(root, "pkg"), cancel: async () => {} });
  assert.equal(nested.warnings.length, 1);
  assert.match(nested.warnings[0], /overlapping workspace/);

  const elsewhere = reg.acquire({
    workspace: path.resolve("/tmp/somewhere-else"),
    cancel: async () => {},
  });
  assert.deepEqual(elsewhere.warnings, []);

  first.release();
  nested.release();
  elsewhere.release();
});

test("the same workspace twice warns", () => {
  const reg = createOperationRegistry();
  const dir = path.resolve("/tmp/same-tree");
  const first = reg.acquire({ workspace: dir, cancel: async () => {} });
  const second = reg.acquire({ workspace: dir, cancel: async () => {} });
  assert.equal(second.warnings.length, 1);
  first.release();
  second.release();
});

test("cancel starts every kill synchronously, before it is awaited", () => {
  // Shutdown dispatches cancellation and exits without awaiting, so a cancel that
  // only starts on a later microtask would never run. Deliberately not awaited.
  const registry = createOperationRegistry();
  let started = false;
  registry.acquire({
    workspace: "/w",
    cancel: async () => {
      started = true;
    },
  });

  const pending = registry.cancel({ cause: "shutdown" });
  assert.equal(started, true, "the kill must be under way before cancel() yields");
  return pending;
});

test("a cancel that throws synchronously is still reported, not rethrown at the caller", async () => {
  // The microtask hop used to turn a sync throw into a rejection. Starting the call
  // directly has to keep that, or the throw escapes cancel() itself.
  const registry = createOperationRegistry();
  registry.acquire({
    workspace: "/w",
    cancel: () => {
      throw new Error("cancel exploded");
    },
  });
  await assert.rejects(() => registry.cancel({ cause: "user" }), /cancel exploded/);
});

// A resume that does not resume: Codex answers `resume A` by starting thread B.
// Both ids used to point at the live record, so a cancel aimed at the thread that
// ended killed the one that replaced it.
test("a replaced thread id stops resolving to the delegation that moved on", async () => {
  const reg = createOperationRegistry();
  let cancels = 0;
  const lease = reg.acquire({
    threadId: "thread-a",
    cancel: async () => {
      cancels += 1;
    },
  });

  lease.updateThreadId("thread-b");

  assert.deepEqual(await reg.cancel({ id: "thread-a" }), {
    status: "not-running",
    id: "thread-a",
  });
  assert.equal(cancels, 0, "cancelling the old thread killed the run that replaced it");

  const byNew = await reg.cancel({ id: "thread-b" });
  assert.equal(byNew.status, "cancelled");
  assert.equal(cancels, 1);
});
