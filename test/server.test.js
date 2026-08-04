import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildServer,
  runDelegateTool,
  runCancelTool,
  maxConcurrentFrom,
  SERVER_INSTRUCTIONS,
} from "../src/server.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
} from "../src/command.js";
import { createOperationRegistry, DEFAULT_MAX_CONCURRENT } from "../src/ops.js";
import { executeDelegate } from "../src/delegate.js";

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

  // The schema is the single source of the defaults. Restating them in the
  // description and the server instructions shipped the same fact three times,
  // on every tool listing, to a caller that can read the schema.
  assert.equal(parsed.model, DEFAULT_MODEL);
  assert.equal(parsed.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.ok(!delegate.description.includes(DEFAULT_MODEL));
  assert.ok(!SERVER_INSTRUCTIONS.includes(DEFAULT_MODEL));
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
      filesReportedByEditTools: [],
      warnings: [],
    }),
  });
  assert.equal(response.structuredContent.status, "completed");
  assert.equal(response.isError, undefined);
});

test("the text copy of a result is compact", async () => {
  const payload = {
    result: "done",
    status: "completed",
    workspace: "/tmp",
    filesReportedByEditTools: ["a.ts", "b.ts"],
  };
  const response = await runDelegateTool({
    args: { spec: "hi" },
    extra: {},
    operationRegistry: createOperationRegistry(),
    execute: async () => payload,
  });

  // It duplicates structuredContent for hosts that ignore structured output;
  // indenting the larger of the two copies is pure cost.
  assert.equal(response.content[0].text, JSON.stringify(payload));
  assert.ok(!response.content[0].text.includes("\n"));
  assert.deepEqual(JSON.parse(response.content[0].text), payload);
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

test("runCancelTool statuses: nothing-active, not-found, cancelled", async () => {
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
  assert.equal(wrong.structuredContent.status, "not-found");

  const cancelled = await runCancelTool({
    args: { threadId: "owned-tid" },
    operationRegistry: registry,
  });
  assert.equal(cancelled.structuredContent.status, "cancelled");
  assert.deepEqual(cancelled.structuredContent.cancelled, [
    { delegationId: lease.delegationId, threadId: "owned-tid" },
  ]);
  assert.match(cancelled.content[0].text, /cancelled/);

  lease.release();
});

test("runCancelTool cancels by delegationId before a thread id exists", async () => {
  const registry = createOperationRegistry();
  let cancelled = false;
  const lease = registry.acquire({
    cancel: async () => {
      cancelled = true;
    },
  });

  const out = await runCancelTool({
    args: { delegationId: lease.delegationId },
    operationRegistry: registry,
  });
  assert.equal(out.structuredContent.status, "cancelled");
  assert.equal(cancelled, true);
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

test("an unknowable exit code does not cost the caller the whole result", async () => {
  // Output validation runs after the handler succeeded: an exitCode the schema
  // rejects throws away the thread id, the edited files and every warning, which
  // is exactly the payload a killed-but-unreaped run needs to deliver.
  const payload = await executeDelegate(
    { spec: "x", mode: "agent", workspace: process.cwd() },
    {
      env: {},
      operationRegistry: createOperationRegistry(),
      resolve: () => ({ command: "/bin/codex", version: "0.144.4", warnings: [] }),
      runProcess: async () => ({
        status: "interrupted",
        reason: "hard-cap",
        exitCode: null,
        threadId: "thr_immortal",
        result: "",
        finalMessageAvailable: false,
        warnings: ["Hard-cap timeout after 1000ms. Raise timeoutMs for longer tasks."],
        stderrBytes: 0,
        filesReportedByEditTools: ["important.ts"],
      }),
    }
  );

  const validated = buildServer()._registeredTools.delegate.outputSchema.safeParse(payload);
  assert.equal(
    validated.success,
    true,
    `payload rejected by the output schema: ${JSON.stringify(validated.error?.issues)}`
  );
  assert.equal(payload.threadId, "thr_immortal");
  assert.deepEqual(payload.filesReportedByEditTools, ["important.ts"]);
  assert.equal(payload.warnings.length, 1);
});

test("the concurrency ceiling comes from the environment, and typos do not cripple it", () => {
  assert.equal(maxConcurrentFrom({}), DEFAULT_MAX_CONCURRENT);
  assert.equal(maxConcurrentFrom({ CODEX_DELEGATE_MAX_CONCURRENT: "5" }), 5);
  assert.equal(maxConcurrentFrom({ CODEX_DELEGATE_MAX_CONCURRENT: "2.7" }), 2);
  // A ceiling below one would disable the tool outright; a typo is not consent to that.
  assert.equal(maxConcurrentFrom({ CODEX_DELEGATE_MAX_CONCURRENT: "0" }), DEFAULT_MAX_CONCURRENT);
  assert.equal(maxConcurrentFrom({ CODEX_DELEGATE_MAX_CONCURRENT: "-3" }), DEFAULT_MAX_CONCURRENT);
  assert.equal(maxConcurrentFrom({ CODEX_DELEGATE_MAX_CONCURRENT: "lots" }), DEFAULT_MAX_CONCURRENT);
  assert.equal(maxConcurrentFrom({ CODEX_DELEGATE_MAX_CONCURRENT: "" }), DEFAULT_MAX_CONCURRENT);
});
