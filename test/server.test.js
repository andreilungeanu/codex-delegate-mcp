import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "./fixtures/temp-dir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  buildServer,
  runDelegateTool,
  runCancelTool,
  delegateOutputShape,
  SERVER_INSTRUCTIONS,
  readStartupCatalog,
} from "../src/server.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "../src/command.js";
import { createOperationRegistry } from "../src/ops.js";
import { executeDelegate } from "../src/delegate.js";

// Through serveStdio, the production entry, in each MCP era it serves: a 2025-era host opens with
// initialize; a 2026-07-28 one sends its identity and capabilities with every request.
const ERAS = [["2025", undefined], ["2026-07-28", { mode: { pin: "2026-07-28" } }]];
async function connectEra(versionNegotiation, serverOpts) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ ...serverOpts, era }), { transport: serverTransport });
  const client = new Client(
    { name: "era-host", version: "3" },
    { capabilities: { elicitation: { form: {} } }, ...(versionNegotiation ? { versionNegotiation } : {}) }
  );
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await served.close(); } };
}
const payloadOf = (result) => JSON.parse(result.content[0].text);

for (const [era, versionNegotiation] of ERAS) {
  test(`doctor reports the host's identity and protocol revision on a ${era}-era connection`, async () => {
    const doctorRunner = async ({ getClientInfo }) => getClientInfo();
    const { client, close } = await connectEra(versionNegotiation, { doctorRunner });
    try {
      const info = payloadOf(await client.callTool({ name: "doctor", arguments: {} }));
      assert.equal(info.version?.name, "era-host");
      assert.deepEqual(info.capabilities?.elicitation, { form: {} });
      if (era === "2025") assert.match(info.protocolVersion, /^2025-/);
      else assert.equal(info.protocolVersion, "2026-07-28");
    } finally {
      await close();
    }
  });

  if (era === "2025") {
    test("on a 2025-era connection initialize names the host, not envelope keys a request carries", async () => {
      const doctorRunner = async ({ getClientInfo }) => getClientInfo();
      const { client, close } = await connectEra(versionNegotiation, { doctorRunner });
      try {
        const _meta = {
          [CLIENT_INFO_META_KEY]: { name: "envelope-host", version: "9" },
          [CLIENT_CAPABILITIES_META_KEY]: { sampling: {} },
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        };
        const info = payloadOf(await client.callTool({ name: "doctor", arguments: {}, _meta }));
        assert.equal(info.version?.name, "era-host");
        assert.deepEqual(info.capabilities, { elicitation: { form: {} } });
        assert.match(info.protocolVersion, /^2025-/);
      } finally {
        await close();
      }
    });
  }

  test(`delegate sends progress and sees the host's cancellation on a ${era}-era connection`, async () => {
    let aborted;
    const executeDelegate = async (_args, { onProgress, signal }) => {
      onProgress("tick");
      aborted = new Promise((resolve) => signal.addEventListener("abort", () => resolve(true), { once: true }));
      await aborted;
      return { result: "", status: "interrupted", reason: "cancelled", workspace: process.cwd() };
    };
    const { client, close } = await connectEra(versionNegotiation, { executeDelegate });
    try {
      const host = new AbortController();
      let ticked;
      const tick = new Promise((resolve) => (ticked = resolve));
      const call = client.callTool(
        { name: "delegate", arguments: { workspace: process.cwd(), spec: "x" } },
        { signal: host.signal, onprogress: (p) => p.message === "tick" && ticked() }
      );
      await tick;
      host.abort();
      await assert.rejects(call);
      assert.equal(await aborted, true, "the host's cancellation must reach the delegation's signal");
    } finally {
      await close();
    }
  });
}

test("buildServer registers delegate, cancel, doctor", () => {
  const server = buildServer({
    executeDelegate: async () => ({ ok: true }),
    doctorRunner: async () => ({ ok: true }),
  });
  assert.ok(server);
});

test("server advertises SEP-973 icons on initialize", async () => {
  const server = buildServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "icons-test-client", version: "1.0" });

  // Assert on the initialize result as sent, not on the client SDK's parse of it.
  const sent = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    // SEP-973 icons on initialize must match the registry listing — HTTPS URLs, not file://.
    const registry = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    const initialize = sent.find((message) => message.result?.serverInfo);
    assert.deepEqual(initialize.result.serverInfo, {
      name: "codex-delegate-mcp",
      version: registry.version,
      icons: registry.icons,
    });
  } finally {
    await client.close();
  }
});

test("delegate tool derives defaults and descriptions from command constants", () => {
  const server = buildServer();
  const delegate = server._registeredTools.delegate;
  const parsed = delegate.inputSchema.parse({ spec: "x", workspace: "/w" });

  // The schema is the single source of the defaults. Restating them in the
  // description and the server instructions shipped the same fact three times,
  // on every tool listing, to a caller that can read the schema.
  assert.equal(parsed.model, DEFAULT_MODEL);
  assert.equal(parsed.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.ok(!delegate.description.includes(DEFAULT_MODEL));
  assert.ok(!SERVER_INSTRUCTIONS.includes(DEFAULT_MODEL));
});

test("the delegate description names only the fields a caller sets", () => {
  // A rule that names some tuning fields reads as "keep these, choose the rest": with model,
  // reasoningEffort and fast named, a fresh caller turned webSearch off and lowered
  // timeoutMs for a one-line ask. A rule naming no field at all reads as "omit what the call
  // can run without", which drops resumeThreadId from the skill's repair resume. So the
  // description names what the workflow sets and covers every other field in one sentence.
  const delegate = buildServer()._registeredTools.delegate;
  const callerSets = ["spec", "mode", "workspace", "resumeThreadId", "reviewTarget"];
  for (const field of Object.keys(delegate.inputSchema.shape)) {
    if (callerSets.includes(field)) continue;
    assert.ok(!delegate.description.includes(field), `description names ${field}`);
  }
  for (const field of callerSets) assert.ok(delegate.description.includes(field), `description omits ${field}`);
  assert.match(delegate.description, /leave every other field at its default unless the user asks/);
});

test("the schema refuses a delegate call that names no workspace", () => {
  // An optional field is a field an orchestrator drops, and dropping this one used
  // to mean the server's own directory. Refusing it in the schema is what makes the
  // caller say which tree, before anything spawns.
  const delegate = buildServer()._registeredTools.delegate;
  const missing = delegate.inputSchema.safeParse({ spec: "x" });
  assert.equal(missing.success, false);
  assert.ok(missing.error.issues.some((i) => i.path.includes("workspace")));
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
    ctx: {},
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
    usage: { scope: "thread", inputTokens: 56609, outputTokens: 996 },
    filesReportedByEditTools: ["a.ts", "b.ts"],
  };
  const response = await runDelegateTool({
    args: { spec: "hi" },
    ctx: {},
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
  assert.deepEqual(z.object(delegateOutputShape).strict().parse(payload), payload);
});

test("runDelegateTool returns isError payload on failure", async () => {
  const err = new Error("boom");
  err.code = "delegate_failed";
  const response = await runDelegateTool({
    args: { spec: "hi" },
    ctx: {},
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

test("a blank cancel selector is refused and cancels nothing; a padded id cancels only its run", async () => {
  const operationRegistry = createOperationRegistry();
  const cancelled = [];
  const leases = ["a", "b"].map((name) =>
    operationRegistry.acquire({ threadId: `tid-${name}`, cancel: async () => cancelled.push(name) })
  );
  const server = buildServer({ operationRegistry });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cancel-test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    for (const args of [{ delegationId: "" }, { threadId: "   " }]) {
      const viaTool = await client.callTool({ name: "cancel", arguments: args });
      assert.equal(viaTool.isError, true, `${JSON.stringify(args)} must be refused`);
      const direct = await runCancelTool({ args, operationRegistry });
      assert.equal(direct.isError, true, `${JSON.stringify(args)} must be refused by the handler too`);
    }
    assert.deepEqual(cancelled, []);

    const padded = await client.callTool({ name: "cancel", arguments: { delegationId: ` ${leases[0].delegationId} ` } });
    assert.equal(JSON.parse(padded.content[0].text).status, "cancelled");
    assert.deepEqual(cancelled, ["a"]);
  } finally {
    await client.close();
    for (const lease of leases) lease.release();
  }
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

  const typo = delegate.inputSchema.safeParse({ spec: "x", workspace: "/w", resumeThredId: "lost" });
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
        warnings: ["Hard-cap timeout after 1000ms. Ask the user before retrying with a higher timeoutMs."],
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

test("an unreadable CLI version does not cost the caller the whole result", async () => {
  // resolveCodex reports version: null when `codex --version` has no x.y.z.
  // The documented shape is a string or an omitted field; sending null is the
  // same class of failure as an unknowable exitCode — a client validating the
  // shape throws away the thread id and the files over one unparsed string.
  const payload = await executeDelegate(
    { spec: "x", mode: "agent", workspace: process.cwd() },
    {
      env: {},
      operationRegistry: createOperationRegistry(),
      resolve: () => ({ command: "/bin/codex", version: null, warnings: [] }),
      runProcess: async () => ({
        status: "completed",
        exitCode: 0,
        threadId: "thr_keep_me",
        result: "ok",
        warnings: [],
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
  assert.equal(payload.threadId, "thr_keep_me");
  assert.deepEqual(payload.filesReportedByEditTools, ["important.ts"]);
  // The version could not be parsed; the payload omits it rather than sending null.
  assert.equal(payload.cliVersion, undefined);
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
      ctx: {},
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

test("runDelegateTool survives a notify that throws synchronously", async () => {
  const response = await runDelegateTool({
    args: { spec: "hi" },
    ctx: {
      mcpReq: {
        _meta: { progressToken: 1 },
        notify: () => {
          throw new Error("Not connected");
        },
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
// declares notify async, so its rejection settles after the handler has
// already returned. The assertion is the absence of an unhandled rejection — the
// tool result is ok either way, which is what makes a result-only test pass against
// code that exits the process in production.
test("runDelegateTool survives a notify that rejects asynchronously", async () => {
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const response = await runDelegateTool({
      args: { spec: "hi" },
      ctx: {
        mcpReq: {
          _meta: { progressToken: 1 },
          notify: async () => {
            throw new Error("Not connected");
          },
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

// The actual entrypoint against a real worker. It has to be busy: an idle server exits on its own
// once stdin ends, whatever the handlers do.
async function shutDownBusyServer(name, shutDown) {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, existsSync, readdirSync } = await import("node:fs");
  const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

  // Stand in for the Codex binary: `node` launched against a file called `exec`,
  // which is the first argument the bridge always passes. It reports a pid and hangs.
  const dir = await mkdtemp(path.join(tmpdir(), `cdm-${name}-`));
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
  // The server's own temp folder, so the delegation's folder can be looked for after the exit.
  const serverTmp = await mkdtemp(path.join(tmpdir(), `cdm-${name}-tmp-`));
  const env = { ...process.env, CODEX_DELEGATE_COMMAND: process.execPath, TEMP: serverTmp, TMP: serverTmp, TMPDIR: serverTmp };
  delete env.CODEX_DELEGATE_DEPTH;

  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
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
    assert.ok(alive(workerPid), "the worker must be running before the shutdown");

    shutDown(child);
    const exit = await exited;

    const until = Date.now() + 20_000;
    while (Date.now() < until && alive(workerPid)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(workerPid), false, "the worker outlived the server");
    assert.deepEqual(readdirSync(serverTmp).filter((entry) => entry.startsWith("codex-delegate-")), [],
      "the delegation's temp folder outlived the shutdown");
    return exit;
  } finally {
    if (child.exitCode === null) child.kill();
    if (workerPid && alive(workerPid)) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {}
    }
  }
}

test("a real server kills its worker and exits when its stdin closes", { timeout: 60_000 }, async () => {
  const exit = await shutDownBusyServer("eof", (child) => child.stdin.end());
  assert.deepEqual(exit, { code: 0, signal: null }, "a host that closed the pipe is a clean shutdown");
});

// On Windows kill() ends the child without running its signal handlers.
const posixSignals = { skip: process.platform === "win32" ? "POSIX signals" : false, timeout: 60_000 };

test("a real server kills its worker and exits 129 on SIGHUP", posixSignals, async () => {
  const exit = await shutDownBusyServer("hup", (child) => child.kill("SIGHUP"));
  assert.deepEqual(exit, { code: 129, signal: null });
});

test("a real server describes the models its CLI lists, read before the first tools/list", { timeout: 60_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

  // Stand in for the Codex binary the same way as above: `node` launched against a file
  // called `debug`, so `codex debug models` prints this catalog. The server is started in
  // that directory because the catalog read inherits its working directory.
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-catalog-"));
  const catalog = {
    models: [
      {
        slug: "gpt-9-shipped-after-this-release",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }, { effort: "max" }, { effort: "persistent" }],
      },
      {
        slug: DEFAULT_MODEL,
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }, { effort: "max" }],
      },
      { slug: "internal-reviewer", visibility: "hide", supported_reasoning_levels: [{ effort: "internal" }] },
    ],
  };
  await writeFile(path.join(dir, "debug"), `console.log(${JSON.stringify(JSON.stringify(catalog))});`);

  const env = { ...process.env, CODEX_DELEGATE_COMMAND: process.execPath };
  delete env.CODEX_DELEGATE_DEPTH;
  const child = spawn(process.execPath, [serverPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env });
  try {
    let buffer = "";
    const reply = (id) =>
      new Promise((resolve) => {
        const check = () => {
          // The text after the last newline is a reply still arriving; tools/list is large
          // enough to come in more than one chunk.
          for (const line of buffer.split("\n").slice(0, -1)) {
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.id === id) return resolve(message);
          }
          child.stdout.once("data", (chunk) => {
            buffer += chunk;
            check();
          });
        };
        check();
      });
    const write = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    await reply(1);
    write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const { result } = await reply(2);

    const delegate = result.tools.find((tool) => tool.name === "delegate");
    // Default first, then the catalog's order; a hidden model is not offered.
    assert.equal(
      delegate.inputSchema.properties.model.description,
      `Codex model id: ${DEFAULT_MODEL}, gpt-9-shipped-after-this-release.`
    );
    assert.equal(
      delegate.inputSchema.properties.reasoningEffort.description,
      "Codex reasoning level: low, xhigh, max, persistent. Tops out at max on " +
        `${DEFAULT_MODEL}. A level the model does not advertise is forwarded, with a warning.`
    );
    assert.equal(delegate.inputSchema.properties.reasoningEffort.default, DEFAULT_REASONING_EFFORT);
    assert.equal(delegate.inputSchema.properties.model.default, DEFAULT_MODEL);
  } finally {
    child.kill();
  }
});

test("with no catalog to read, the model and level fields point at doctor instead of naming a list", () => {
  const hiddenOnly = [{ slug: "internal-reviewer", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] }];
  const noLevels = [{ slug: DEFAULT_MODEL, visibility: "list" }];
  for (const catalog of [null, [], hiddenOnly]) {
    const delegate = buildServer({ catalog })._registeredTools.delegate;
    assert.equal(
      delegate.inputSchema.shape.model.description,
      "Codex model id. doctor deep:true lists every id."
    );
  }
  for (const catalog of [null, [], hiddenOnly, noLevels]) {
    const delegate = buildServer({ catalog })._registeredTools.delegate;
    assert.equal(
      delegate.inputSchema.shape.reasoningEffort.description,
      "Codex reasoning level. doctor deep:true lists each model's levels."
    );
  }
});

test("the level field names no shortfall when every listed model reaches the top level", () => {
  const levels = [{ effort: "low" }, { effort: "xhigh" }];
  const catalog = [
    { slug: DEFAULT_MODEL, visibility: "list", supported_reasoning_levels: levels },
    { slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: levels },
  ];
  const delegate = buildServer({ catalog })._registeredTools.delegate;
  assert.equal(
    delegate.inputSchema.shape.reasoningEffort.description,
    "Codex reasoning level: low, xhigh. A level the model does not advertise is forwarded, with a warning."
  );
});

test("the level field groups models by the level they stop at, as Codex 0.160 lists them", () => {
  const upTo = (top) => {
    const all = ["low", "medium", "high", "xhigh", "max", "ultra"];
    return all.slice(0, all.indexOf(top) + 1).map((effort) => ({ effort }));
  };
  const catalog = [
    ["gpt-6-astra", "ultra"],
    ["gpt-6.1-sol", "ultra"],
    ["gpt-6-luna", "max"],
    ["gpt-5.6-luna", "max"],
    ["gpt-5.5", "xhigh"],
  ].map(([slug, top]) => ({ slug, visibility: "list", supported_reasoning_levels: upTo(top) }));
  const delegate = buildServer({ catalog })._registeredTools.delegate;
  assert.equal(
    delegate.inputSchema.shape.reasoningEffort.description,
    "Codex reasoning level: low, medium, high, xhigh, max, ultra. Tops out at max on gpt-6-luna, gpt-5.6-luna; " +
      "xhigh on gpt-5.5. A level the model does not advertise is forwarded, with a warning."
  );
});

test("the level description orders reordered and partial catalogs, excluding unknown and hidden lists", () => {
  const levels = (...efforts) => efforts.map((effort) => ({ effort }));
  const catalog = [
    { slug: "gpt-5.5", visibility: "list", supported_reasoning_levels: levels("low", "high", "xhigh") },
    { slug: "no-levels", visibility: "list" },
    { slug: DEFAULT_MODEL, visibility: "list", supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max") },
    { slug: "partial-model", visibility: "list", supported_reasoning_levels: [{ effort: "unknown" }, null] },
    { slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max", "ultra") },
    { slug: "hidden-model", visibility: "hide", supported_reasoning_levels: levels("low", "secret") },
  ];
  for (const models of [catalog, [...catalog].reverse()]) {
    const delegate = buildServer({ catalog: models })._registeredTools.delegate;
    const shortfall = models === catalog
      ? `xhigh on gpt-5.5; max on ${DEFAULT_MODEL}`
      : `max on ${DEFAULT_MODEL}; xhigh on gpt-5.5`;
    assert.equal(
      delegate.inputSchema.shape.reasoningEffort.description,
      `Codex reasoning level: low, medium, high, xhigh, max, ultra. Tops out at ${shortfall}. ` +
        "A level the model does not advertise is forwarded, with a warning."
    );
  }
});

test("partial lists describe the highest level without a complete reference model", () => {
  const levels = (...efforts) => efforts.map((effort) => ({ effort }));
  const catalog = [
    { slug: DEFAULT_MODEL, visibility: "list", supported_reasoning_levels: levels("low", "xhigh", "max") },
    { slug: "gpt-5.5", visibility: "list", supported_reasoning_levels: levels("low", "medium", "high", "xhigh") },
  ];
  const delegate = buildServer({ catalog })._registeredTools.delegate;
  assert.equal(
    delegate.inputSchema.shape.reasoningEffort.description,
    "Codex reasoning level: low, medium, high, xhigh, max. Tops out at xhigh on gpt-5.5. " +
      "A level the model does not advertise is forwarded, with a warning."
  );
});

test("the catalog the description names is the one the delegate preflight trusts", async () => {
  const catalog = [{ slug: "gpt-9-shipped-after-this-release", visibility: "list" }];
  let seen;
  const server = buildServer({
    catalog,
    executeDelegate: async (_args, options) => {
      seen = options;
      return { result: "ok", status: "completed", workspace: "/w" };
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "catalog-test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "delegate", arguments: { spec: "x", workspace: "/w" } });
  } finally {
    await client.close();
  }

  assert.equal(seen.catalog, catalog);
  assert.ok(seen.operationRegistry, "the options runDelegateTool builds still arrive");
});

test("the startup catalog read is bounded, and a CLI that does not resolve reads nothing", async () => {
  let seen;
  const models = [{ slug: DEFAULT_MODEL, visibility: "list" }];
  const read = await readStartupCatalog({
    env: {},
    resolve: () => ({ command: "/bin/codex" }),
    readCatalog: async (options) => {
      seen = options;
      return models;
    },
  });
  assert.equal(read, models);
  // Unbounded, the reader's own 8s default would hold up the host's connection that long.
  assert.deepEqual(seen, { command: "/bin/codex", commandArgs: [], timeoutMs: 5000 });

  // An npm install resolves to node plus the bin script, which the read has to carry.
  await readStartupCatalog({
    env: {},
    resolve: () => ({ command: "/bin/node", commandArgs: ["/npm/codex.js"] }),
    readCatalog: async (options) => {
      seen = options;
      return models;
    },
  });
  assert.deepEqual(seen, { command: "/bin/node", commandArgs: ["/npm/codex.js"], timeoutMs: 5000 });

  let reads = 0;
  const none = await readStartupCatalog({
    env: {},
    resolve: () => {
      throw new Error("codex not found");
    },
    readCatalog: async () => {
      reads++;
      return models;
    },
  });
  assert.equal(none, null);
  assert.equal(reads, 0);
});
