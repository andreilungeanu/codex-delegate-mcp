import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildServer,
  runDelegateTool,
  runCancelTool,
  SERVER_INSTRUCTIONS,
} from "../src/server.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
} from "../src/command.js";
import { createOperationRegistry } from "../src/ops.js";

test("buildServer registers delegate, cancel, doctor", () => {
  const server = buildServer({
    executeDelegate: async () => ({ ok: true }),
    doctorRunner: async () => ({ ok: true }),
  });
  assert.ok(server);
});

test("delegate tool derives defaults and descriptions from command constants", () => {
  const server = buildServer();
  const delegate = server._registeredTools.delegate;
  const parsed = delegate.inputSchema.parse({ spec: "x" });

  assert.equal(parsed.model, DEFAULT_MODEL);
  assert.equal(parsed.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.match(delegate.description, new RegExp(DEFAULT_MODEL));
  assert.match(delegate.description, new RegExp(DEFAULT_REASONING_EFFORT));
  assert.match(SERVER_INSTRUCTIONS, new RegExp(DEFAULT_MODEL));
  assert.match(SERVER_INSTRUCTIONS, new RegExp(DEFAULT_REASONING_EFFORT));
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

test("runCancelTool returns an error payload when cancellation fails", async () => {
  const registry = createOperationRegistry();
  const lease = registry.acquire({
    threadId: "owned-tid",
    cancel: async () => {
      throw new Error("cancel boom");
    },
  });

  const response = await runCancelTool({ args: {}, operationRegistry: registry });

  assert.equal(response.isError, true);
  assert.deepEqual(JSON.parse(response.content[0].text), {
    error: "cancel_failed",
    message: "cancel boom",
  });
  lease.release();
});

test("an unknown delegate input is rejected instead of silently dropped", () => {
  const server = buildServer({ executeDelegate: async () => ({}) });
  const delegate = server._registeredTools.delegate;

  const typo = delegate.inputSchema.safeParse({ spec: "x", resumeThredId: "lost" });
  assert.equal(typo.success, false);
  assert.match(typo.error.issues[0].message, /Unrecognized key/);

  const ok = delegate.inputSchema.safeParse({
    spec: "x",
    resumeThreadId: "tid",
    workspace: "/w",
  });
  assert.equal(ok.success, true);
});
