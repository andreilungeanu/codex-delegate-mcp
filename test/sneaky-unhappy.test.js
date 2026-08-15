import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateDelegateInput, buildCodexArgs } from "../src/command.js";
import { createOperationRegistry } from "../src/ops.js";
import { runCodexProcess, readFinalResult } from "../src/run-codex.js";
import { executeDelegate } from "../src/delegate.js";

function parkedChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new Readable({ read() {} });
  child.stderr = Readable.from([]);
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function linesChild(lines, { exitCode = 0, afterEnd } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = Readable.from(lines.map((l) => `${l}\n`));
  child.stderr = Readable.from([]);
  child.exitCode = null;
  child.signalCode = null;
  child.stdout.on("end", () => {
    setImmediate(async () => {
      try {
        if (afterEnd) await afterEnd(child);
      } finally {
        child.exitCode = exitCode;
        child.emit("close", exitCode);
      }
    });
  });
  return child;
}

// --- Subtle input / argv ---

test("whitespace-only model is rejected; blank reasoningEffort falls back", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "x", model: "   " }),
    (err) => err.code === "invalid_model"
  );
  const req = validateDelegateInput({
    spec: "x",
    reasoningEffort: "\t",
  });
  assert.equal(req.model, "gpt-5.6-terra");
  assert.equal(req.reasoningEffort, "high");
});

test("a spec that looks like CLI flags never reaches argv at all", () => {
  const spec = "--json --help; rm -rf /";
  const { args, stdin } = buildCodexArgs(
    {
      spec,
      mode: "ask",
      workspace: "/tmp/r",
      webSearch: false,
    },
    { resultFile: "/tmp/o.txt" }
  );
  // It travels on stdin now, which is safer than a `--` separator:
  // there is no token for Codex to reinterpret, and nothing for another process on
  // the machine to read out of the command line.
  assert.equal(stdin, spec);
  assert.ok(!args.includes(spec));
  const sep = args.indexOf("--");
  assert.ok(sep > 0);
  assert.equal(args[sep + 1], "-");
});

test("resume does not pass --cd (cwd is the workspace contract)", () => {
  const { args, kind } = buildCodexArgs(
    {
      spec: "continue",
      mode: "agent",
      workspace: "D:\\other\\workspace",
      resumeThreadId: "019f64c2-4592-7213-ab3c-253dd1a1c42c",
      webSearch: false,
    },
    { resultFile: "D:\\tmp\\o.txt" }
  );
  assert.equal(kind, "resume");
  assert.ok(!args.includes("--cd"));
  assert.ok(!args.includes("D:\\other\\workspace"));
  assert.ok(args.includes("--skip-git-repo-check"));
});

test("ask must not receive --output-schema even if a schema path is passed", () => {
  assert.throws(
    () =>
      buildCodexArgs(
        { spec: "q", mode: "ask", workspace: "/r", webSearch: false },
        { resultFile: "/tmp/o.txt", outputSchemaFile: "/tmp/schema.json" }
      ),
    /output schema is not supported in ask mode/i
  );
});

// --- Cancel ownership edge cases ---

test("a stale threadId cancels nothing while the active thread is still unknown", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const lease = reg.acquire({
    threadId: null,
    cancel: async () => {
      hits += 1;
    },
  });
  const result = await reg.cancel({ threadId: "stale-from-previous-turn" });
  assert.equal(result.status, "not-found");
  assert.equal(hits, 0);
  lease.release();
});

test("cancel without threadId still works before thread.started", async () => {
  const reg = createOperationRegistry();
  let hits = 0;
  const lease = reg.acquire({
    threadId: null,
    cancel: async () => {
      hits += 1;
    },
  });
  const result = await reg.cancel({});
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 1);
  lease.release();
});

test("failed cancel surfaces and second cancel rethrows same failure", async () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({
    threadId: "t1",
    cancel: async () => {
      throw new Error("kill failed");
    },
  });
  await assert.rejects(() => reg.cancel({}), /kill failed/);
  await assert.rejects(() => reg.cancel({}), /kill failed/);
  assert.equal(lease.getCancellation()?.status, "failed");
  lease.release();
});

// --- Process / final-result sneaky paths ---

test("a hard-cap timeout reports hard-cap, not cancelled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-timeout-"));
  const resultFile = path.join(dir, "last.txt");
  let childRef = null;

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    timeoutMs: 30,
    spawnImpl: () => {
      childRef = parkedChild({ pid: 777 });
      return childRef;
    },
    treeKillImpl: async () => {
      childRef.stdout.push(null);
      childRef.exitCode = 1;
      childRef.emit("close", 1);
    },
    platform: "linux",
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.reason, "hard-cap");
});

test("exit 0 while turn still in_progress is not completed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-inprog-"));
  const resultFile = path.join(dir, "last.txt");
  await writeFile(resultFile, "STALE_OR_PARTIAL", "utf8");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      linesChild(
        [
          JSON.stringify({ type: "thread.started", thread_id: "t-inprog" }),
          JSON.stringify({ type: "turn.started" }),
          // never turn.completed
        ],
        {
          exitCode: 0,
          afterEnd: async () => {
            await writeFile(resultFile, "SHOULD_NOT_COUNT", "utf8");
          },
        }
      ),
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.notEqual(result.status, "completed");
  assert.equal(result.finalMessageAvailable, false);
  assert.equal(result.result, "");
});

test("turn.completed with non-zero exit refuses final file contents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-exitnz-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      linesChild(
        [
          JSON.stringify({ type: "thread.started", thread_id: "t-nz" }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ],
        {
          exitCode: 3,
          afterEnd: async () => {
            await writeFile(resultFile, "LOOKS_FINAL_BUT_EXIT_BAD", "utf8");
          },
        }
      ),
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.finalMessageAvailable, false);
  assert.equal(result.result, "");
});

test("malformed JSONL lines are ignored; later valid events still apply", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-junk-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      linesChild(
        [
          "this is not json",
          "{broken",
          JSON.stringify({ type: "thread.started", thread_id: "t-junk" }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ],
        {
          exitCode: 0,
          afterEnd: async () => writeFile(resultFile, "ok", "utf8"),
        }
      ),
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.threadId, "t-junk");
  assert.equal(result.status, "completed");
  assert.equal(result.result, "ok");
});

test("onProgress throwing must not crash the run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-prog-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    onProgress: () => {
      throw new Error("progress sink exploded");
    },
    spawnImpl: () =>
      linesChild(
        [
          JSON.stringify({ type: "thread.started", thread_id: "t-prog" }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ],
        {
          exitCode: 0,
          afterEnd: async () => writeFile(resultFile, "survived", "utf8"),
        }
      ),
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.result, "survived");
});

test("empty final message file is available but empty (no fabrication)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-empty-"));
  const file = path.join(dir, "empty.txt");
  await writeFile(file, "", "utf8");
  const out = await readFinalResult({ filePath: file, status: "completed", exitCode: 0 });
  assert.equal(out.finalMessageAvailable, true);
  assert.equal(out.result, "");
});

test("spawn ENOENT rejects and does not leave registry leased", async () => {
  const registry = createOperationRegistry();
  await assert.rejects(
    () =>
      executeDelegate(
        { spec: "x", mode: "ask", workspace: process.cwd() },
        {
          env: {},
          operationRegistry: registry,
          resolve: () => ({
            command: "/nonexistent/codex-binary",
            version: "0.144.4",
            source: "test",
            warnings: [],
          }),
          runProcess: async () => {
            const err = new Error("spawn ENOENT");
            err.code = "ENOENT";
            throw err;
          },
        }
      ),
    /ENOENT/
  );
  assert.equal(registry.snapshot().active, false);
});

test("an orphan holding stdout does not wedge the single-slot registry", async () => {
  const registry = createOperationRegistry();
  // Every run leaves a background process on stdout, so 'close' never arrives.
  const options = () => ({
    env: {},
    operationRegistry: registry,
    resolve: () => ({ command: "/bin/codex", version: "0.144.4", warnings: [] }),
    runProcess: (opts) =>
      runCodexProcess({
        ...opts,
        platform: "linux",
        heartbeatMs: 0,
        drainMs: 60,
        spawnImpl: () => {
          const child = new EventEmitter();
          child.pid = 4242;
          child.stdout = new Readable({ read() {} });
          child.stderr = new Readable({ read() {} });
          child.exitCode = null;
          child.signalCode = null;
          child.stdout.push(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
          writeFile(opts.resultFile, "done", "utf8").then(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          });
          return child;
        },
      }),
  });

  const first = await executeDelegate(
    { spec: "one", mode: "ask", workspace: process.cwd() },
    options()
  );
  // The slot has to be free for this one, or it comes back operation_in_progress.
  const second = await executeDelegate(
    { spec: "two", mode: "ask", workspace: process.cwd() },
    options()
  );

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(registry.snapshot().active, false);
});

test("plan mode with invalid shape fails with result-unavailable", async () => {
  const result = await executeDelegate(
    { spec: "plan", mode: "plan", workspace: process.cwd() },
    {
      env: {},
      operationRegistry: createOperationRegistry(),
      resolve: () => ({
        command: "/bin/codex",
        version: "0.144.4",
        source: "test",
        warnings: [],
      }),
      runProcess: async ({ onThreadId }) => {
        onThreadId?.("t-plan-shape");
        return {
          status: "completed",
          exitCode: 0,
          threadId: "t-plan-shape",
          timedOut: false,
          cancelled: false,
          result: JSON.stringify({ nope: true, steps: "not-array" }),
          finalMessageAvailable: true,
          warnings: [],
          stderrBytes: 0,
          filesReportedByEditTools: [],
        };
      },
    }
  );
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "result-unavailable");
  assert.equal(result.plan, undefined);
  assert.equal(result.result, "");
});

test("a plan over the former step limit is returned in full", async () => {
  const steps = Array.from({ length: 201 }, (_, i) => ({
    title: `step ${i}`,
    detail: "d".repeat(200),
  }));
  const result = await executeDelegate(
    { spec: "plan", mode: "plan", workspace: process.cwd() },
    {
      env: {},
      operationRegistry: createOperationRegistry(),
      resolve: () => ({ command: "/bin/codex", version: "0.144.4", warnings: [] }),
      runProcess: async () => ({
        status: "completed",
        exitCode: 0,
        threadId: "t-plan-big",
        result: JSON.stringify({ overview: "big", steps }),
        finalMessageAvailable: true,
        warnings: [],
        stderrBytes: 0,
        filesReportedByEditTools: [],
      }),
    }
  );

  // A model cannot emit a pathological plan without hitting its own output
  // limit first; truncating the step list was a cap on content already bounded
  // by construction.
  assert.equal(result.status, "completed");
  assert.equal(result.plan.steps.length, 201);
  assert.equal(result.plan.overview, "big");
  assert.equal(result.result, "big");
});

test("pre-aborted outer signal interrupts before/during run", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already done"));
  const result = await executeDelegate(
    { spec: "x", mode: "ask", workspace: process.cwd() },
    {
      env: {},
      signal: controller.signal,
      operationRegistry: createOperationRegistry(),
      resolve: () => ({
        command: "/bin/codex",
        version: "0.144.4",
        source: "test",
        warnings: [],
      }),
      runProcess: async ({ signal }) => {
        assert.equal(signal.aborted, true);
        return {
          status: "interrupted",
          exitCode: 1,
          threadId: null,
          timedOut: false,
          cancelled: true,
          result: "",
          finalMessageAvailable: false,
          warnings: ["interrupted"],
          stderrBytes: 0,
          filesReportedByEditTools: [],
        };
      },
    }
  );
  assert.equal(result.status, "interrupted");
});

test("CODEX_DELEGATE_DEPTH=0 still refuses nesting", async () => {
  await assert.rejects(
    () =>
      executeDelegate(
        { spec: "x" },
        {
          env: { CODEX_DELEGATE_DEPTH: "0" },
          resolve: () => ({ command: "x", version: "0.144.4", warnings: [] }),
        }
      ),
    (err) => err.code === "recursion_refused"
  );
});
