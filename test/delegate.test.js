import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDelegate } from "../src/delegate.js";
import { createOperationRegistry } from "../src/ops.js";

test("executeDelegate refuses nested recursion", async () => {
  await assert.rejects(
    () =>
      executeDelegate(
        { spec: "x" },
        { env: { CODEX_DELEGATE_DEPTH: "1" }, resolve: () => ({ command: "x", version: "0.144.4", warnings: [] }) }
      ),
    /nested delegation/
  );
});

test("executeDelegate wires resolve + process + touched files", async () => {
  const registry = createOperationRegistry();
  const result = await executeDelegate(
    { spec: "add a comment", mode: "ask", workspace: process.cwd() },
    {
      env: {},
      operationRegistry: registry,
      resolve: () => ({
        command: "/bin/codex",
        version: "0.144.4",
        source: "test",
        warnings: [],
      }),
      runProcess: async ({ onThreadId, resultFile }) => {
        onThreadId?.("thread-abc");
        return {
          status: "completed",
          exitCode: 0,
          threadId: "thread-abc",
          timedOut: false,
          cancelled: false,
          result: "looks fine",
          finalMessageAvailable: true,
          warnings: [],
          stderrBytes: 0,
        };
      },
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.threadId, "thread-abc");
  assert.equal(result.mode, "ask");
  assert.equal(result.result, "looks fine");
  assert.equal(result.finalMessageAvailable, true);
  assert.ok(Array.isArray(result.touchedFiles));
  assert.ok(Array.isArray(result.warnings));
});
