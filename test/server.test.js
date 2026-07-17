import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer, runDelegateTool, runCancelTool } from "../src/server.js";
import { createOperationRegistry } from "../src/ops.js";

test("buildServer registers delegate, cancel, doctor", () => {
  const server = buildServer({
    executeDelegate: async () => ({ ok: true }),
    doctorRunner: async () => ({ ok: true }),
  });
  assert.ok(server);
});

test("runDelegateTool returns structuredContent on success", async () => {
  const registry = createOperationRegistry();
  const response = await runDelegateTool({
    args: { spec: "hi" },
    extra: {},
    operationRegistry: registry,
    execute: async () => ({
      result: "done",
      finalMessageAvailable: true,
      status: "completed",
      resumed: false,
      mode: "agent",
      workspace: "/tmp",
      filesReportedByAgent: [],
      warnings: [],
    }),
  });
  assert.equal(response.structuredContent.status, "completed");
  assert.equal(response.isError, undefined);
});

test("runDelegateTool returns isError payload on failure", async () => {
  const err = new Error("boom");
  err.code = "delegate_failed";
  const response = await runDelegateTool({
    args: { spec: "hi" },
    extra: {},
    operationRegistry: createOperationRegistry(),
    execute: async () => {
      throw err;
    },
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /boom/);
});

test("runCancelTool statuses: nothing-active, cancelled, not-owned", async () => {
  const registry = createOperationRegistry();

  const idle = await runCancelTool({ args: {}, operationRegistry: registry });
  assert.equal(idle.structuredContent.status, "nothing-active");

  const lease = registry.acquire({
    threadId: "owned-tid",
    cancel: async () => {},
  });

  const wrong = await runCancelTool({
    args: { threadId: "other-tid" },
    operationRegistry: registry,
  });
  assert.equal(wrong.structuredContent.status, "not-owned");
  assert.equal(wrong.structuredContent.activeThreadId, "owned-tid");

  const cancelled = await runCancelTool({
    args: { threadId: "owned-tid" },
    operationRegistry: registry,
  });
  assert.equal(cancelled.structuredContent.status, "cancelled");
  assert.equal(cancelled.structuredContent.threadId, "owned-tid");
  assert.match(cancelled.content[0].text, /cancelled/);

  lease.release();
});
