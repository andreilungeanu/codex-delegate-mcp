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
