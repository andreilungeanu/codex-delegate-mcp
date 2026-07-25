import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDelegate } from "../src/delegate.js";
import { createOperationRegistry } from "../src/ops.js";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

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
      filesReportedByEditTools: [],
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

test("executeDelegate wires resolve + process + edit-tool files", async () => {
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
          filesReportedByEditTools: [],
        };
      },
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.threadId, "thread-abc");
  assert.equal(result.mode, undefined);
  assert.equal(result.result, "looks fine");
  assert.equal(result.filesReportedByEditTools, undefined);
  assert.equal(result.warnings, undefined);
});

test("executeDelegate reports a resume only when the observed thread matches", async () => {
  const result = await executeDelegate(
    { spec: "continue", resumeThreadId: "thread-existing", workspace: process.cwd() },
    delegateOptions("thread-existing")
  );

  assert.equal(result.resumed, true);
  assert.equal(result.threadId, "thread-existing");
  assert.equal(result.warnings, undefined);
});

test("executeDelegate warns when a requested resume starts a new thread", async () => {
  const result = await executeDelegate(
    { spec: "continue", resumeThreadId: "thread-stale", workspace: process.cwd() },
    delegateOptions("thread-new")
  );

  // A resume was requested, so resumed:false is the answer — and it is the whole
  // answer; prose repeating the two thread ids the caller already has is noise.
  assert.equal(result.resumed, false);
  assert.equal(result.threadId, "thread-new");
  assert.equal(result.warnings, undefined);
});

test("executeDelegate does not infer a thread when a requested resume has no observed id", async () => {
  const result = await executeDelegate(
    { spec: "continue", resumeThreadId: "thread-stale", workspace: process.cwd() },
    delegateOptions(null)
  );

  assert.equal(result.resumed, false);
  assert.equal(result.threadId, undefined);
  assert.equal(result.warnings, undefined);
});

test("executeDelegate reports a fresh run as not resumed", async () => {
  const result = await executeDelegate(
    { spec: "start", workspace: process.cwd() },
    delegateOptions("thread-new")
  );

  assert.equal(result.resumed, undefined);
  assert.equal(result.threadId, "thread-new");
  assert.equal(result.warnings, undefined);
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
          filesReportedByEditTools: [],
        };
      },
    }
  );

  assert.equal(result.mode, undefined);
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
        filesReportedByEditTools: [],
      }),
    }
  );
  assert.deepEqual(result.plan, plan);
  assert.ok(!(result.warnings || []).some((w) => /not valid JSON/i.test(w)));
});

test("resolver setup notes stay out of the per-run warnings", async () => {
  const options = delegateOptions("tid-w");
  options.resolve = () => ({
    command: "/bin/codex",
    version: "0.145.0",
    source: "standalone",
    warnings: ["PATH Codex on Windows can degrade workspace-write."],
  });
  const result = await executeDelegate({ spec: "hi", workspace: process.cwd() }, options);
  assert.equal(result.warnings, undefined);
});

test("the temp directory is removed when argv construction throws", async () => {
  const before = (await readdir(tmpdir())).filter((n) => n.startsWith("codex-delegate-")).length;
  await assert.rejects(
    executeDelegate(
      { spec: "x".repeat(40_000), workspace: process.cwd() },
      delegateOptions("tid-big")
    ),
    /argv is too long/
  );
  const after = (await readdir(tmpdir())).filter((n) => n.startsWith("codex-delegate-")).length;
  assert.equal(after, before);
});

test("a cancel landing after a clean finish is not reported as cancelled", async () => {
  const registry = createOperationRegistry();
  const options = delegateOptions("tid-race");
  options.operationRegistry = registry;
  options.runProcess = async () => {
    // Fire, don't await: cancel now waits for this run to settle, so awaiting it
    // from inside the run would deadlock by construction.
    registry.cancel({ threadId: undefined, cause: "user" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    return {
      status: "completed",
      exitCode: 0,
      threadId: "tid-race",
      timedOut: false,
      cancelled: false,
      result: "done",
      finalMessageAvailable: true,
      warnings: [],
      filesReportedByEditTools: [],
    };
  };
  const result = await executeDelegate({ spec: "hi", workspace: process.cwd() }, options);
  assert.equal(result.status, "completed");
  assert.equal(result.reason, undefined);
});

test("plan mode returns the plan once, with result holding only the overview", async () => {
  const plan = {
    overview: "Split the parser out of the reducer.",
    steps: [
      { title: "Extract", detail: "Move the JSONL branch chain into parse-event.js." },
      { title: "Wire", detail: "Call it from run-codex.js and keep the reducer stateless." },
    ],
  };
  const raw = JSON.stringify(plan);
  const options = delegateOptions("tid-plan");
  options.runProcess = async () => ({
    status: "completed",
    exitCode: 0,
    threadId: "tid-plan",
    result: raw,
    finalMessageAvailable: true,
    warnings: [],
    filesReportedByEditTools: [],
  });

  const result = await executeDelegate(
    { spec: "plan it", mode: "plan", workspace: process.cwd() },
    options
  );

  assert.deepEqual(result.plan, plan);
  assert.equal(result.result, plan.overview);
  assert.ok(!result.result.includes("steps"), "result must not repeat the plan JSON");
  assert.ok(JSON.stringify(result).length < raw.length * 2);
});

test("an unparseable plan keeps the raw final message in result", async () => {
  const options = delegateOptions("tid-bad");
  options.runProcess = async () => ({
    status: "completed",
    exitCode: 0,
    threadId: "tid-bad",
    result: "not json at all",
    finalMessageAvailable: true,
    warnings: [],
    filesReportedByEditTools: [],
  });

  const result = await executeDelegate(
    { spec: "plan it", mode: "plan", workspace: process.cwd() },
    options
  );

  assert.equal(result.plan, undefined);
  assert.equal(result.result, "not json at all");
  assert.ok(result.warnings.some((w) => /not valid JSON/i.test(w)));
});

test("cancel resolves only after the delegation has actually settled", async () => {
  const registry = createOperationRegistry();
  const options = delegateOptions("tid-cancel");
  options.operationRegistry = registry;

  let releaseRun;
  const runGate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const order = [];

  options.runProcess = async ({ signal }) => {
    signal.addEventListener("abort", () => order.push("abort-seen"), { once: true });
    await runGate;
    order.push("run-settled");
    return {
      status: "interrupted",
      reason: "cancelled",
      exitCode: 1,
      threadId: "tid-cancel",
      result: "",
      finalMessageAvailable: false,
      warnings: [],
      filesReportedByEditTools: [],
    };
  };

  const delegation = executeDelegate({ spec: "long", workspace: process.cwd() }, options);
  await new Promise((r) => setTimeout(r, 10));

  const cancelling = registry.cancel({ cause: "user" }).then((out) => {
    order.push("cancel-returned");
    return out;
  });

  // Cancel must still be pending while the run is in flight.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["abort-seen"]);

  releaseRun();
  const [cancelResult] = await Promise.all([cancelling, delegation]);

  assert.equal(cancelResult.status, "cancelled");
  assert.deepEqual(order, ["abort-seen", "run-settled", "cancel-returned"]);
});
