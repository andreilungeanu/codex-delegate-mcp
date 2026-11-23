import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdtemp } from "./fixtures/temp-dir.mjs";
import { buildServer } from "../src/server.js";
import { createOperationRegistry } from "../src/ops.js";
import { executeDelegate as realExecuteDelegate } from "../src/delegate.js";
import { TASKS_EXTENSION, createTaskStore } from "../src/tasks.js";

const ENTRY = fileURLToPath(new URL("../src/server.js", import.meta.url));
const envelope = (tasks = true) => ({
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_CAPABILITIES_META_KEY]: { extensions: tasks ? { [TASKS_EXTENSION]: {} } : {} },
  [CLIENT_INFO_META_KEY]: { name: "raw-host", version: "1" },
});
const payloadOf = (result) => JSON.parse(result.content[0].text);

// A 2026-07-28 host in raw JSON-RPC: the SDK client fails a call answered with a task.
async function connectRaw(serverOpts = {}) {
  const tasks = createTaskStore();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ tasks, ...serverOpts, era }), { transport: serverTransport });
  const replies = new Map();
  let nextId = 0;
  clientTransport.onmessage = (m) => {
    if (m.id != null && replies.has(m.id)) {
      replies.get(m.id)(m);
      replies.delete(m.id);
    }
  };
  await clientTransport.start();
  const send = (method, params = {}, { tasks: listsTasks = true } = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve) => replies.set(id, resolve));
    clientTransport.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope(listsTasks) } });
    return reply;
  };
  await send("server/discover");
  return {
    send,
    delegate: (args = {}, opts) =>
      send("tools/call", { name: "delegate", arguments: { workspace: process.cwd(), spec: "x", ...args } }, opts),
    close: async () => {
      await clientTransport.close();
      await served.close();
    },
  };
}

async function waitForTask(raw, taskId, done = (t) => t.status !== "working") {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { result, error } = await raw.send("tasks/get", { taskId });
    if (error) throw new Error(`tasks/get ${taskId}: ${JSON.stringify(error)}`);
    if (done(result)) return result;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still ${result.status}: ${result.statusMessage}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** An executeDelegate that starts `threadId` and settles when `finish` is called or its run is aborted. */
function heldRun(threadId = "thread-1") {
  const seen = { calls: [] };
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  const executeDelegate = async (args, options) => {
    seen.calls.push({ args, options });
    options.onProgress(`delegation id: ${options.delegationId}`);
    options.onThreadStarted?.(threadId);
    const aborted = new Promise((resolve) =>
      options.signal?.addEventListener("abort", () => resolve({ status: "interrupted", reason: "cancelled", threadId }), { once: true })
    );
    return Promise.race([finished.then(() => ({ status: "completed", threadId, result: "done" })), aborted]);
  };
  return { executeDelegate, seen, finish: () => finish() };
}

test("a 2026-07-28 connection advertises the tasks extension and a 2025-era one does not", async () => {
  const raw = await connectRaw();
  try {
    const { result } = await raw.send("server/discover");
    assert.deepEqual(result.capabilities.extensions?.[TASKS_EXTENSION], {});
  } finally {
    await raw.close();
  }
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ era }), { transport: serverTransport });
  const client = new Client({ name: "legacy-host", version: "1" });
  await client.connect(clientTransport);
  try {
    assert.equal(client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION], undefined);
  } finally {
    await client.close();
    await served.close();
  }
});

test("a delegate call listing the tasks extension is answered with a task that completes with the result", async () => {
  const held = heldRun();
  const raw = await connectRaw({ executeDelegate: held.executeDelegate });
  try {
    const call = await raw.delegate();
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    assert.equal(held.seen.calls[0].options.delegationId, call.result.taskId, "the task id is the delegation id");
    const working = await waitForTask(raw, call.result.taskId, () => true);
    assert.equal(working.status, "working");
    held.finish();
    const task = await waitForTask(raw, call.result.taskId);
    assert.equal(task.status, "completed");
    assert.equal(payloadOf(task.result).result, "done");
  } finally {
    await raw.close();
  }
});

test("a delegate call that does not list the extension is answered with the result", async () => {
  const held = heldRun();
  const raw = await connectRaw({ executeDelegate: held.executeDelegate });
  try {
    const call = raw.delegate({}, { tasks: false });
    await new Promise((r) => setTimeout(r, 50));
    held.finish();
    const { result } = await call;
    assert.equal(result.resultType, "complete");
    assert.equal(payloadOf(result).result, "done");
  } finally {
    await raw.close();
  }
});

test("a delegation that fails before Codex starts a thread answers the request, not a task", async () => {
  const executeDelegate = async () => {
    throw Object.assign(new Error("Unknown model"), { code: "invalid_model" });
  };
  const raw = await connectRaw({ executeDelegate });
  try {
    const { result } = await raw.delegate({ model: "gpt-unknown" });
    assert.equal(result.resultType, "complete");
    assert.equal(result.isError, true);
    assert.equal(payloadOf(result).error, "invalid_model");
  } finally {
    await raw.close();
  }
});

test("tasks/update needs its inputResponses map", async () => {
  const held = heldRun();
  const raw = await connectRaw({ executeDelegate: held.executeDelegate });
  try {
    const call = await raw.delegate();
    const { taskId } = call.result;
    assert.equal((await raw.send("tasks/update", { taskId })).error?.code, -32602);
    assert.equal((await raw.send("tasks/update", { taskId, inputResponses: {} })).error, undefined);
    held.finish();
  } finally {
    await raw.close();
  }
});

test("tasks/cancel stops the run, and the task names the thread to resume", async () => {
  const held = heldRun("thread-9");
  const raw = await connectRaw({ executeDelegate: held.executeDelegate });
  try {
    const call = await raw.delegate();
    await raw.send("tasks/cancel", { taskId: call.result.taskId });
    const task = await waitForTask(raw, call.result.taskId);
    assert.equal(task.status, "cancelled");
    assert.match(task.statusMessage, /resumeThreadId thread-9/);
    assert.equal(held.seen.calls[0].options.signal.aborted, true, "the run was not stopped");
  } finally {
    await raw.close();
  }
});

test("resumeThreadId takes a task id and resumes the task's thread", async () => {
  const held = heldRun("thread-7");
  const raw = await connectRaw({ executeDelegate: held.executeDelegate });
  try {
    const first = await raw.delegate();
    held.finish();
    await waitForTask(raw, first.result.taskId);
    const second = await raw.delegate({ resumeThreadId: first.result.taskId });
    await waitForTask(raw, second.result.taskId);
    assert.equal(held.seen.calls[1].args.resumeThreadId, "thread-7");
  } finally {
    await raw.close();
  }
});

test("resumeThreadId takes the id of a task the store has already dropped", async () => {
  const threads = ["thread-a", "thread-b"];
  const seen = [];
  const executeDelegate = async (args, options) => {
    seen.push(args.resumeThreadId);
    options.onThreadStarted?.(threads[seen.length - 1]);
    return { status: "completed", result: "done" };
  };
  let now = Date.now();
  const raw = await connectRaw({ executeDelegate, tasks: createTaskStore({ now: () => now }) });
  try {
    const first = await raw.delegate();
    await waitForTask(raw, first.result.taskId);
    now += 60 * 60 * 1000 + 1;
    const dropped = await raw.send("tasks/get", { taskId: first.result.taskId });
    assert.ok(dropped.error, "the first task should have been dropped");
    await raw.delegate({ resumeThreadId: first.result.taskId });
    assert.equal(seen[1], "thread-a");
  } finally {
    await raw.close();
  }
});

test("cancel reaches a task's run by its task id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-task-cancel-"));
  const script = path.join(dir, "codex.js");
  await writeFile(script, `console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-live" })); setInterval(() => {}, 1000);`);
  const operationRegistry = createOperationRegistry();
  const executeDelegate = (input, options) =>
    realExecuteDelegate(input, {
      ...options,
      env: {},
      resolve: () => ({ command: process.execPath, commandArgs: [script], version: "0.171.0", warnings: [] }),
    });
  const raw = await connectRaw({ executeDelegate, operationRegistry });
  try {
    const call = await raw.delegate();
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    const cancel = await raw.send("tools/call", { name: "cancel", arguments: { delegationId: call.result.taskId } });
    assert.equal(payloadOf(cancel.result).status, "cancelled");
    const task = await waitForTask(raw, call.result.taskId);
    assert.equal(payloadOf(task.result).status, "interrupted");
  } finally {
    await operationRegistry.cancel({});
    await raw.close();
  }
});

// The bin over stdio, with `node` as Codex running a file called `exec` in the workspace: the
// first argument the bridge passes.
async function rawServer(name, execBody) {
  const dir = await mkdtemp(path.join(tmpdir(), `cdm-${name}-`));
  const pidFile = path.join(dir, "worker.pid");
  await writeFile(
    path.join(dir, "exec"),
    `const fs = require("fs");
     const argv = process.argv.slice(2);
     fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-real" }));
     ${execBody}`
  );
  const env = { ...process.env, CODEX_DELEGATE_COMMAND: process.execPath };
  delete env.CODEX_DELEGATE_DEPTH;
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const replies = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id != null && replies.has(m.id)) {
      replies.get(m.id)(m);
      replies.delete(m.id);
    }
  });
  const send = (method, params = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} in 30 s`)), 30_000);
      replies.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope() } }) + "\n");
    return reply;
  };
  const workerPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : undefined);
  const cleanup = async () => {
    if (child.exitCode === null) child.kill();
    const pid = workerPid();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      const until = Date.now() + 5_000;
      while (Date.now() < until && alive(pid)) await new Promise((r) => setTimeout(r, 50));
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      console.error(`left ${dir}: ${err.message}`);
    }
  };
  return { dir, child, send, exited, workerPid, cleanup };
}

// A zombie counts as gone: an orphan's reaper in a container may never collect it.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === "EPERM";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return true;
  }
};

test("the binary answers a delegate call listing the tasks extension with a task that completes", { timeout: 60_000 }, async () => {
  const server = await rawServer(
    "task-done",
    `fs.writeFileSync(argv[argv.indexOf("--output-last-message") + 1], "done");
     console.log(JSON.stringify({ type: "turn.completed", usage: {} }));`
  );
  try {
    const discover = await server.send("server/discover");
    assert.deepEqual(discover.result.capabilities.extensions?.[TASKS_EXTENSION], {});
    const call = await server.send("tools/call", { name: "delegate", arguments: { workspace: server.dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    let task;
    const deadline = Date.now() + 30_000;
    do {
      await new Promise((r) => setTimeout(r, 100));
      task = (await server.send("tasks/get", { taskId: call.result.taskId })).result;
    } while (task.status === "working" && Date.now() < deadline);
    assert.equal(task.status, "completed");
    const out = payloadOf(task.result);
    assert.equal(out.status, "completed");
    assert.equal(out.threadId, "thread-real");
    assert.equal(out.result, "done");
  } finally {
    server.child.stdin.end();
    await server.exited;
    await server.cleanup();
  }
});

// The request is answered, so the SDK's abort of in-flight requests on EOF does not reach the run.
test("a host that closes stdin mid-task leaves no Codex process behind", { timeout: 60_000 }, async () => {
  const server = await rawServer("task-eof", "setInterval(() => {}, 1000);");
  try {
    await server.send("server/discover");
    const call = await server.send("tools/call", { name: "delegate", arguments: { workspace: server.dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    const pid = server.workerPid();
    assert.ok(pid && alive(pid), "Codex should be running when the host leaves");
    server.child.stdin.end();
    const until = Date.now() + 20_000;
    while (Date.now() < until && alive(pid)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, "Codex outlived the host");
    assert.equal(await server.exited, 0);
  } finally {
    await server.cleanup();
  }
});

// Codex has exited and a process it started holds its stdout, so the run is in its drain.
test("tasks/cancel after Codex exited keeps the result and still stops what Codex left running", { skip: process.platform === "win32" ? "POSIX process groups" : false, timeout: 60_000 }, async () => {
  const server = await rawServer(
    "task-drain-cancel",
    `fs.writeFileSync(argv[argv.indexOf("--output-last-message") + 1], "done");
     const held = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
     fs.writeFileSync("held.pid", String(held.pid));
     held.unref();
     console.log(JSON.stringify({ type: "turn.completed", usage: {} }));`
  );
  let heldPid;
  try {
    await server.send("server/discover");
    const call = await server.send("tools/call", { name: "delegate", arguments: { workspace: server.dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    const workerPid = server.workerPid();
    const exited = Date.now() + 10_000;
    while (Date.now() < exited && alive(workerPid)) await new Promise((r) => setTimeout(r, 20));
    heldPid = Number(readFileSync(path.join(server.dir, "held.pid"), "utf8"));
    assert.ok(alive(heldPid), "the held process should be running when the cancel arrives");
    await server.send("tasks/cancel", { taskId: call.result.taskId });
    const gone = Date.now() + 10_000;
    while (Date.now() < gone && alive(heldPid)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(heldPid), false, "the process Codex left running outlived the cancel");
    let task;
    do task = (await server.send("tasks/get", { taskId: call.result.taskId })).result;
    while (task.status === "working");
    assert.equal(task.status, "completed");
    assert.equal(payloadOf(task.result).result, "done");
  } finally {
    if (heldPid && alive(heldPid)) process.kill(heldPid, "SIGKILL");
    server.child.stdin.end();
    await server.exited;
    await server.cleanup();
  }
});

// A host that dies breaks the server's stdout first; the transport then pauses stdin, so no 'end'.
test("a host whose stdout pipe breaks mid-task leaves no Codex process behind", { timeout: 60_000 }, async () => {
  const server = await rawServer("task-epipe", "setInterval(() => {}, 1000);");
  try {
    await server.send("server/discover");
    const call = await server.send("tools/call", { name: "delegate", arguments: { workspace: server.dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    const pid = server.workerPid();
    assert.ok(pid && alive(pid), "Codex should be running when the host goes");
    server.child.stdout.destroy();
    const poll = { jsonrpc: "2.0", id: 999, method: "tasks/get", params: { taskId: call.result.taskId, _meta: envelope() } };
    for (let i = 0; i < 5; i++) {
      server.child.stdin.write(JSON.stringify({ ...poll, id: 999 + i }) + "\n");
      await new Promise((r) => setTimeout(r, 100));
    }
    server.child.stdin.end();
    const until = Date.now() + 20_000;
    while (Date.now() < until && alive(pid)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, "Codex outlived the host");
  } finally {
    await server.cleanup();
  }
});
