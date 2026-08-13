import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  buildServer,
  runDelegateTool,
  runCancelTool,
  delegateOutputShape,
  SERVER_INSTRUCTIONS,
} from "../src/server.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
} from "../src/command.js";
import { createOperationRegistry } from "../src/ops.js";
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

test("runDelegateTool returns the result as its only payload on success", async () => {
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
  assert.equal(JSON.parse(response.content[0].text).status, "completed");
  assert.equal(response.isError, undefined);
});

test("a result is returned once, as one compact JSON block", async () => {
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

  // structuredContent plus a text copy puts the whole payload in the model's context
  // twice on any host that reads both — Codex does. One block, and not indented.
  assert.equal(response.structuredContent, undefined);
  assert.equal(response.content.length, 1);
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
  assert.equal(JSON.parse(idle.content[0].text).status, "nothing-active");

  const lease = registry.acquire({
    threadId: "owned-tid",
    cancel: async () => {},
  });

  const wrong = await runCancelTool({
    args: { threadId: "other-tid" },
    operationRegistry: registry,
  });
  assert.equal(JSON.parse(wrong.content[0].text).status, "not-found");

  const cancelled = await runCancelTool({
    args: { threadId: "owned-tid" },
    operationRegistry: registry,
  });
  const cancelledPayload = JSON.parse(cancelled.content[0].text);
  assert.equal(cancelledPayload.status, "cancelled");
  assert.deepEqual(cancelledPayload.cancelled, [
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
  assert.equal(JSON.parse(out.content[0].text).status, "cancelled");
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
  // No outputSchema is declared, so nothing rejects a payload at runtime.
  // This is the compensating check: strict, so a field delegate.js starts returning
  // and delegateOutputShape never learned about fails here rather than shipping
  // undocumented. An exitCode the shape rejects would throw away the thread id, the
  // edited files and every warning — exactly what a killed-but-unreaped run must deliver.
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

  const validated = z.object(delegateOutputShape).strict().safeParse(payload);
  assert.equal(
    validated.success,
    true,
    `payload rejected by the documented shape: ${JSON.stringify(validated.error?.issues)}`
  );
  assert.equal(payload.threadId, "thr_immortal");
  assert.deepEqual(payload.filesReportedByEditTools, ["important.ts"]);
  assert.equal(payload.warnings.length, 1);
});

const progressResult = {
  result: "ok",
  finalMessageAvailable: true,
  status: "completed",
  resumed: false,
  mode: "agent",
  workspace: "/tmp",
  filesReportedByEditTools: [],
  warnings: [],
};

test("runDelegateTool survives a sendNotification that throws synchronously", async () => {
  const response = await runDelegateTool({
    args: { spec: "hi" },
    extra: {
      _meta: { progressToken: 1 },
      sendNotification: () => {
        throw new Error("Not connected");
      },
    },
    operationRegistry: createOperationRegistry(),
    execute: async (_args, { onProgress }) => {
      onProgress("still working");
      return progressResult;
    },
  });
  assert.equal(response.isError, undefined);
});

// The synchronous stub above never reaches the path that actually breaks: the SDK
// declares sendNotification async, so its rejection settles after the handler has
// already returned. The assertion is the absence of an unhandled rejection — the
// tool result is ok either way, which is what makes a result-only test pass against
// code that exits the process in production.
test("runDelegateTool survives a sendNotification that rejects asynchronously", async () => {
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const response = await runDelegateTool({
      args: { spec: "hi" },
      extra: {
        _meta: { progressToken: 1 },
        sendNotification: async () => {
          throw new Error("Not connected");
        },
      },
      operationRegistry: createOperationRegistry(),
      execute: async (_args, { onProgress }) => {
        onProgress("still working");
        return progressResult;
      },
    });
    // The rejection lands on a later microtask than the handler's own return.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.isError, undefined);
    assert.equal(JSON.parse(response.content[0].text).result, "ok");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(rejections, []);
});
