import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRegistry } from "../src/ops.js";

test("acquire rejects a second active operation", () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({ cancel: async () => {} });
  assert.throws(() => reg.acquire({ cancel: async () => {} }), /already active/);
  lease.release();
  const lease2 = reg.acquire({ cancel: async () => {} });
  lease2.release();
});

test("cancel returns nothing-active when idle", async () => {
  const reg = createOperationRegistry();
  const result = await reg.cancel({});
  assert.equal(result.status, "nothing-active");
});

test("cancel invokes owned cancel and reports cancelled", async () => {
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

test("cancel with wrong threadId returns not-owned", async () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({ threadId: "t1", cancel: async () => {} });
  const result = await reg.cancel({ threadId: "other" });
  assert.equal(result.status, "not-owned");
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

test("cancel during in-flight operation aborts via cancel callback", async () => {
  const reg = createOperationRegistry();
  let cancelled = false;
  const lease = reg.acquire({
    threadId: "in-flight",
    cancel: async () => {
      cancelled = true;
    },
  });

  assert.deepEqual(reg.snapshot(), {
    active: true,
    threadId: "in-flight",
    cancellation: null,
  });

  const result = await reg.cancel({ cause: "user" });
  assert.equal(result.status, "cancelled");
  assert.equal(cancelled, true);
  assert.equal(lease.getCancellation()?.status, "cancelled");
  assert.equal(lease.getCancellation()?.cause, "user");
  lease.release();
  assert.deepEqual(reg.snapshot(), { active: false });
});
