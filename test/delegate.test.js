import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDelegate, envMs } from "../src/delegate.js";
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
          warnings: [],
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

test("executeDelegate reports resumed:false, and nothing more, when a resume starts a new thread", async () => {
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

test("executeDelegate plan mode fails with result-unavailable on non-JSON", async () => {
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
          warnings: [],
          filesReportedByEditTools: [],
        };
      },
    }
  );

  // Plan mode promised structured output; prose that cannot be parsed is a
  // failed result contract, not a completed run with a warning.
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "result-unavailable");
  assert.equal(result.plan, undefined);
  assert.equal(result.result, "");
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
    warnings: ["Preferring the standalone Codex binary on Windows."],
  });
  const result = await executeDelegate({ spec: "hi", workspace: process.cwd() }, options);
  assert.equal(result.warnings, undefined);
});

test("the temp directory is removed when argv construction throws", async () => {
  const before = (await readdir(tmpdir())).filter((n) => n.startsWith("codex-delegate-")).length;
  await assert.rejects(
    executeDelegate(
      {
        // Only review still builds the brief into argv, so it is the only mode left
        // that can fail this way.
        spec: "x".repeat(40_000),
        mode: "review",
        reviewTarget: { kind: "uncommitted" },
        workspace: process.cwd(),
      },
      { ...delegateOptions("tid-big"), preflight: async () => {} }
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
  // The plan must be carried once, not once in `plan` and again in `result`.
  // Counting an occurrence beats budgeting bytes: the envelope also holds the
  // workspace path and a uuid, so a byte cap passes or fails on cwd length.
  const serialized = JSON.stringify(result);
  for (const step of plan.steps) {
    assert.equal(serialized.split(step.detail).length - 1, 1, `${step.title} detail sent twice`);
  }
});

test("an unparseable plan fails with result-unavailable and no raw text", async () => {
  const options = delegateOptions("tid-bad");
  options.runProcess = async () => ({
    status: "completed",
    exitCode: 0,
    threadId: "tid-bad",
    result: "not json at all",
    warnings: [],
    filesReportedByEditTools: [],
  });

  const result = await executeDelegate(
    { spec: "plan it", mode: "plan", workspace: process.cwd() },
    options
  );

  // The raw text is not exposed either: it is not the structured plan that was
  // promised, and half an answer is worse than an explicit absence.
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "result-unavailable");
  assert.equal(result.plan, undefined);
  assert.equal(result.result, "");
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

test("a malformed timeout knob falls back instead of arming a broken deadline", () => {
  // Unset and blank take the default.
  assert.equal(envMs(undefined, 5000), 5000);
  assert.equal(envMs(null, 5000), 5000);
  assert.equal(envMs("   ", 5000), 5000);
  // Garbage, fractions and negatives would arm a guard that fails every call.
  assert.equal(envMs("soon", 5000), 5000);
  assert.equal(envMs("12.5", 5000), 5000);
  assert.equal(envMs("-1", 5000), 5000);
  // A real value wins, and an explicit 0 disables its guard rather than defaulting.
  assert.equal(envMs("250", 5000), 250);
  assert.equal(envMs("0", 5000), 0);
});

test("the delegation id is announced before the run and returned with it", async () => {
  const progress = [];
  const result = await executeDelegate(
    { spec: "x", mode: "ask", workspace: process.cwd() },
    { ...delegateOptions("thread-1"), onProgress: (m) => progress.push(m) }
  );

  assert.ok(result.delegationId);
  // First, so a caller has a cancel handle for a run that wedges before Codex
  // ever announces a thread id.
  assert.equal(progress[0], `delegation id: ${result.delegationId}`);
});

test("an onProgress throwing on the announce still releases the lease", async () => {
  const registry = createOperationRegistry();
  // The server's sink cannot throw; a library caller's can. The delegate fails
  // either way — what matters is that the record is gone, so a later cancel
  // settles instead of waiting on a run that will never start.
  await assert.rejects(
    () =>
      executeDelegate(
        { spec: "x", mode: "ask", workspace: process.cwd() },
        {
          ...delegateOptions("thread-1"),
          operationRegistry: registry,
          onProgress: () => {
            throw new Error("progress sink broke");
          },
        }
      ),
    /progress sink broke/
  );

  const cancel = await registry.cancel({ cause: "user" });
  assert.equal(cancel.status, "nothing-active");
});

test("two delegations in one workspace warn about clobbering each other", async () => {
  const registry = createOperationRegistry();
  const options = { ...delegateOptions("thread-1"), operationRegistry: registry };

  let releaseFirst;
  const firstRunning = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = executeDelegate(
    { spec: "x", mode: "agent", workspace: process.cwd() },
    {
      ...options,
      runProcess: async () => {
        await firstRunning;
        return {
          status: "completed",
          exitCode: 0,
          threadId: "thread-1",
          result: "done",
          warnings: [],
          filesReportedByEditTools: [],
        };
      },
    }
  );
  // Let the first delegation reach the registry before the second starts.
  await new Promise((resolve) => setImmediate(resolve));

  const second = await executeDelegate(
    { spec: "y", mode: "agent", workspace: process.cwd() },
    options
  );
  assert.match(second.warnings?.join(" ") ?? "", /overlapping workspace/);

  releaseFirst();
  const firstResult = await first;
  // The first delegation was alone when it started, so it says nothing.
  assert.equal(firstResult.warnings, undefined);
});
