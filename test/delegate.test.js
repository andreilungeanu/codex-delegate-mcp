import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDelegate } from "../src/delegate.js";
import { createOperationRegistry } from "../src/ops.js";

function delegateOptions(threadId) {
  return {
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
      threadId,
      timedOut: false,
      cancelled: false,
      result: "done",
      finalMessageAvailable: true,
      warnings: [],
      filesReportedByAgent: [],
    }),
  };
}

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

test("executeDelegate wires resolve + process + agent-reported files", async () => {
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
          filesReportedByAgent: [],
        };
      },
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.threadId, "thread-abc");
  assert.equal(result.mode, "ask");
  assert.equal(result.result, "looks fine");
  assert.equal(result.finalMessageAvailable, true);
  assert.ok(Array.isArray(result.filesReportedByAgent));
  assert.ok(Array.isArray(result.warnings));
});

test("executeDelegate reports a resume only when the observed thread matches", async () => {
  const result = await executeDelegate(
    { spec: "continue", resumeThreadId: "thread-existing", workspace: process.cwd() },
    delegateOptions("thread-existing")
  );

  assert.equal(result.resumed, true);
  assert.equal(result.threadId, "thread-existing");
  assert.equal(result.warnings.length, 0);
});

test("executeDelegate warns when a requested resume starts a new thread", async () => {
  const result = await executeDelegate(
    { spec: "continue", resumeThreadId: "thread-stale", workspace: process.cwd() },
    delegateOptions("thread-new")
  );

  assert.equal(result.resumed, false);
  assert.equal(result.threadId, "thread-new");
  assert.ok(
    result.warnings.includes(
      "Requested resume of thread thread-stale but the agent started new thread thread-new; prior context did not carry over."
    )
  );
});

test("executeDelegate does not infer a thread when a requested resume has no observed id", async () => {
  const result = await executeDelegate(
    { spec: "continue", resumeThreadId: "thread-stale", workspace: process.cwd() },
    delegateOptions(null)
  );

  assert.equal(result.resumed, false);
  assert.equal(result.threadId, undefined);
  assert.equal(result.warnings.length, 0);
});

test("executeDelegate reports a fresh run as not resumed", async () => {
  const result = await executeDelegate(
    { spec: "start", workspace: process.cwd() },
    delegateOptions("thread-new")
  );

  assert.equal(result.resumed, false);
  assert.equal(result.threadId, "thread-new");
  assert.equal(result.warnings.length, 0);
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
          filesReportedByAgent: [],
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
        filesReportedByAgent: [],
      }),
    }
  );
  assert.deepEqual(result.plan, plan);
  assert.ok(!result.warnings.some((w) => /not valid JSON/i.test(w)));
});
