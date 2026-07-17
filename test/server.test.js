import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer, runDelegateTool } from "../src/server.js";
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
      touchedFiles: [],
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
