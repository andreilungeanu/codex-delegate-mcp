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
    (err) => err.code === "recursion_refused"
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
      runProcess: async ({ onThreadId }) => {
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

test("executeDelegate plan mode warns when final message is not JSON", async () => {
  const registry = createOperationRegistry();
  let capturedSchema = null;
  const result = await executeDelegate(
    { spec: "outline the work", mode: "plan", workspace: process.cwd() },
    {
      env: {},
      operationRegistry: registry,
      resolve: () => ({
        command: "/bin/codex",
        version: "0.144.4",
        source: "test",
        warnings: [],
      }),
      runProcess: async ({ args }) => {
        const idx = args.indexOf("--output-schema");
        assert.ok(idx !== -1, "plan mode must pass --output-schema");
        capturedSchema = args[idx + 1];
        assert.ok(capturedSchema);
        return {
          status: "completed",
          exitCode: 0,
          threadId: "plan-tid",
          timedOut: false,
          cancelled: false,
          result: "not-json{{{",
          finalMessageAvailable: true,
          warnings: [],
          stderrBytes: 0,
        };
      },
    }
  );

  assert.equal(result.mode, "plan");
  assert.equal(result.plan, undefined);
  assert.ok(
    result.warnings.some((w) => /not valid JSON/i.test(w)),
    `expected JSON warning, got ${JSON.stringify(result.warnings)}`
  );
});

test("executeDelegate plan mode parses valid plan JSON", async () => {
  const plan = { overview: "ship it", steps: [{ title: "one", detail: "do one" }] };
  const result = await executeDelegate(
    { spec: "outline", mode: "plan", workspace: process.cwd() },
    {
      env: {},
      operationRegistry: createOperationRegistry(),
      resolve: () => ({
        command: "/bin/codex",
        version: "0.144.4",
        source: "test",
        warnings: [],
      }),
      runProcess: async () => ({
        status: "completed",
        exitCode: 0,
        threadId: "plan-ok",
        timedOut: false,
        cancelled: false,
        result: JSON.stringify(plan),
        finalMessageAvailable: true,
        warnings: [],
        stderrBytes: 0,
      }),
    }
  );
  assert.deepEqual(result.plan, plan);
  assert.ok(!result.warnings.some((w) => /not valid JSON/i.test(w)));
});
