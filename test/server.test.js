import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  buildServer,
  runDelegateTool,
  runCancelTool,
  delegateOutputShape,
  SERVER_INSTRUCTIONS,
  installSignalCleanup,
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

test("cancel tool description is the live-run status schema", () => {
  // cancel has no outputSchema; the description is the only place a caller
  // sees which statuses exist.
  const cancel = buildServer()._registeredTools.cancel;
  assert.match(cancel.description, /cancelled/);
  assert.match(cancel.description, /nothing-active/);
  assert.match(cancel.description, /not-found/);
  assert.equal(cancel.description.includes("not-running"), false);
});

test("runDelegateTool returns the result as its only payload on success", async () => {
  const registry = createOperationRegistry();
  const response = await runDelegateTool({
    args: { spec: "hi" },
    extra: {},
    operationRegistry: registry,
    execute: async () => ({
      result: "done",
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
        warnings: ["Hard-cap timeout after 1000ms. Raise timeoutMs for longer tasks."],
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
  // The process never reported a code; the payload omits it rather than
  // synthesizing one.
  assert.equal(payload.exitCode, undefined);
});

test("the output shape accepts result-unavailable and rejects an unknown reason", () => {
  const base = { result: "", status: "failed", workspace: "/w" };

  const ok = z.object(delegateOutputShape).strict().safeParse({
    ...base,
    reason: "result-unavailable",
  });
  assert.equal(ok.success, true);

  const typo = z.object(delegateOutputShape).strict().safeParse({
    ...base,
    reason: "result-unavailible",
  });
  assert.equal(typo.success, false);
});

test("the serialized delegation result never contains resultSource", async () => {
  // Whatever the outcome, the payload must not carry a salvage marker: there is
  // no salvage. A field that can appear on some outcomes is caller knowledge
  // forever, and this one stopped existing.
  const outcomes = [
    { result: "the answer", status: "completed", workspace: "/w" },
    {
      result: "",
      status: "failed",
      reason: "result-unavailable",
      threadId: "t1",
      workspace: "/w",
      warnings: ["Final result file missing or unreadable."],
    },
    { result: "", status: "interrupted", reason: "cancelled", workspace: "/w" },
  ];
  for (const payload of outcomes) {
    const response = await runDelegateTool({
      args: { spec: "hi" },
      extra: {},
      operationRegistry: createOperationRegistry(),
      execute: async () => payload,
    });
    assert.equal(response.isError, undefined);
    assert.equal(response.content[0].text.includes("resultSource"), false);
  }
});

const progressResult = {
  result: "ok",
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

test("the binary answers --version without starting the transport", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { VERSION } = await import("../src/version.js");

  // Spawned with a timeout on purpose: the failure this guards against is the
  // stdio server starting and waiting on stdin forever, which reads as a wedged
  // install rather than as a wrong answer.
  const entry = fileURLToPath(new URL("../src/server.js", import.meta.url));
  for (const flag of ["--version", "-v"]) {
    const { stdout } = await promisify(execFile)(process.execPath, [entry, flag], {
      timeout: 10_000,
    });
    assert.equal(stdout.trim(), VERSION, `${flag} must print the version`);
  }
});

/** Drive installSignalCleanup without signalling the test runner. */
async function fireSignal(registry) {
  const exits = [];
  const scheduled = [];
  const before = process.listeners("SIGINT").slice();
  installSignalCleanup(registry, {
    exit: (code) => exits.push(code),
    setExitCode: () => {},
    armExitBelt: () => {},
    schedule: (fn) => scheduled.push(fn),
  });
  const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
  for (const listener of added) listener();
  for (const listener of added) listener();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  for (const listener of before) process.on("SIGINT", listener);
  // The exit rides the kills' settlement, one clean loop turn later; flush the
  // microtasks and drain the turn so callers observe the exited process.
  await new Promise((resolve) => setImmediate(resolve));
  for (const fn of scheduled.splice(0)) fn();
  return exits;
}

test("a shutdown signal dispatches the kill before the process exits", async () => {
  // The load-bearing assertion. The handler cannot await — that would stall Ctrl-C
  // for the kill deadline — so the kill has to be under way by the time the handler
  // returns. A cancel started on a later microtask would never run at all.
  const order = [];
  const scheduled = [];
  const registry = {
    cancel: async () => {
      order.push("kill-dispatched");
    },
  };
  const exits = [];
  const before = process.listeners("SIGINT").slice();
  installSignalCleanup(registry, {
    exit: (code) => {
      order.push("exit");
      exits.push(code);
    },
    setExitCode: () => {},
    armExitBelt: () => {},
    schedule: (fn) => scheduled.push(fn),
  });
  const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
  added[0]();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  for (const listener of before) process.on("SIGINT", listener);
  // Still inside the handler's aftermath: the kill is dispatched, the exit is not.
  assert.deepEqual(order, ["kill-dispatched"]);
  assert.deepEqual(exits, []);
  await new Promise((resolve) => setImmediate(resolve));
  for (const fn of scheduled.splice(0)) fn();

  assert.deepEqual(order, ["kill-dispatched", "exit"]);
  assert.deepEqual(exits, [130]);
});

test("a shutdown signal always exits, including a second one", async () => {
  // Registering a handler replaces Node's default exit. A path that misses `exit`
  // would swallow Ctrl-C, which is worse than the tree it was meant to clean up.
  let calls = 0;
  const exits = await fireSignal({
    cancel: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 1, "the second signal must not restart cancellation");
  assert.deepEqual(exits, [130, 130]);
});

test("a cancel that fails on shutdown still exits and raises no unhandled rejection", async () => {
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const async = await fireSignal({
      cancel: async () => {
        throw new Error("tree would not die");
      },
    });
    const sync = await fireSignal({
      cancel: () => {
        throw new Error("cancel threw synchronously");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(async, [130, 130]);
    assert.deepEqual(sync, [130, 130]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(rejections, []);
});

test("stdin closing dispatches the kill before the process exits", async () => {
  // The MCP stdio shutdown sequence is: close the server's stdin, wait for it to
  // exit, then signal. A server that ignores EOF never reaches the signal on a host
  // that shuts down politely, and the delegation runs on with nobody to hand it to.
  const { EventEmitter } = await import("node:events");
  const order = [];
  const stdin = new EventEmitter();
  const scheduled = [];
  const exits = [];
  const before = process.listeners("SIGINT").slice();

  installSignalCleanup(
    {
      cancel: async () => {
        order.push("kill-dispatched");
      },
    },
    {
      exit: (code) => {
        order.push("exit");
        exits.push(code);
      },
      setExitCode: () => {},
      armExitBelt: () => {},
      schedule: (fn) => scheduled.push(fn),
      stdin,
    }
  );
  stdin.emit("end");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  for (const listener of before) process.on("SIGINT", listener);
  await new Promise((resolve) => setImmediate(resolve));
  for (const fn of scheduled.splice(0)) fn();

  assert.deepEqual(order, ["kill-dispatched", "exit"]);
  assert.deepEqual(exits, [0], "a host that closed the pipe is a clean shutdown");
});

test("the exit leaves the signal path, but the exit code and belt do not wait", async () => {
  // Two reasons the exit is carried by the kills' settlement instead of the
  // handler: a process.exit before taskkill has walked the tree orphans the
  // tree on Windows (measured in the sibling cursor bridge), and a handler
  // stack is the worst place from which to tear a process down. The exit code
  // and the hard-kill belt are armed inside the handler itself, so they hold
  // even if that deferred exit never gets to run.
  const exitCodes = [];
  const exits = [];
  const belts = [];
  const scheduled = [];
  const before = process.listeners("SIGINT").slice();
  installSignalCleanup(
    { cancel: async () => {} },
    {
      exit: (code) => exits.push(code),
      setExitCode: (code) => exitCodes.push(code),
      armExitBelt: (kill) => belts.push(kill),
      schedule: (fn) => scheduled.push(fn),
    }
  );
  const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
  added[0]();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  for (const listener of before) process.on("SIGINT", listener);

  assert.deepEqual(exitCodes, [130], "exit code is recorded in the handler");
  assert.equal(belts.length, 1, "the belt is armed in the handler");
  assert.deepEqual(exits, [], "no exit inside the handler");
  assert.deepEqual(scheduled, [], "nothing even scheduled yet — kills settle first");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1, "one deferred exit, after the kills settled");
  scheduled[0]();
  assert.deepEqual(exits, [130]);
});

test("the exit belt hard-kills the process if the graceful exit never lands", async () => {
  // A belt on the main loop cannot fire when the main loop is the thing that
  // stopped, which is why the default belt runs on a worker thread; this pins
  // the contract it fulfills.
  const hardKills = [];
  const belts = [];
  const before = process.listeners("SIGINT").slice();
  installSignalCleanup(
    { cancel: async () => {} },
    {
      exit: () => {},
      setExitCode: () => {},
      armExitBelt: (kill) => belts.push(kill),
      killSelf: () => hardKills.push("sigkill"),
      schedule: () => {},
    }
  );
  const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
  added[0]();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  for (const listener of before) process.on("SIGINT", listener);

  assert.equal(belts.length, 1, "armed on shutdown");
  belts[0]();
  assert.deepEqual(hardKills, ["sigkill"], "the belt's only move is the hard kill");
});

// The only test here that runs the actual entrypoint against a real worker. Every
// test above injects an exit and a registry, and none of them would notice that
// nothing is listening for EOF. An idle server would not either: with no delegation
// holding the loop open it exits on its own the moment stdin ends, whatever the
// handlers do. So this one has to be busy to mean anything.
test("a real server kills its worker and exits when its stdin closes", { timeout: 60_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, existsSync } = await import("node:fs");
  const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

  // Stand in for the Codex binary: `node` launched against a file called `exec`,
  // which is the first argument the bridge always passes. It reports a pid and hangs.
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-eof-"));
  const pidFile = path.join(dir, "worker.pid");
  await writeFile(
    path.join(dir, "exec"),
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     console.log(JSON.stringify({ type: "turn.started" }));
     setInterval(() => {}, 1000);`
  );

  // The suite itself can be running inside a delegation, and the recursion marker is
  // inherited through this spread: the server would then refuse its own delegate call
  // and this test would wait out the whole spawn deadline for a worker that never came.
  const env = { ...process.env, CODEX_DELEGATE_COMMAND: process.execPath };
  delete env.CODEX_DELEGATE_DEPTH;

  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let workerPid;
  try {
    let buffer = "";
    const sawServerInfo = new Promise((resolve) => {
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("serverInfo")) resolve();
      });
    });
    const write = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    await sawServerInfo;
    write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delegate", arguments: { spec: "hang", workspace: dir, timeoutMs: 600_000 } },
    });

    const spawned = Date.now() + 30_000;
    while (Date.now() < spawned && !existsSync(pidFile)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    workerPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(alive(workerPid), "the worker must be running before the pipe closes");

    child.stdin.end();

    const exitCode = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 0, "a host that closed the pipe is a clean shutdown");

    const until = Date.now() + 20_000;
    while (Date.now() < until && alive(workerPid)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(workerPid), false, "the worker outlived the host that closed the pipe");
  } finally {
    if (child.exitCode === null) child.kill();
    if (workerPid && alive(workerPid)) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {}
    }
  }
});
