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

test("spec that looks like CLI flags stays after -- separator", () => {
  const { args } = buildCodexArgs(
    {
      spec: "--json --help; rm -rf /",
      mode: "ask",
      workspace: "/tmp/r",
      network: false,
    },
    { resultFile: "/tmp/o.txt", platform: "linux" }
  );
  const sep = args.indexOf("--");
  assert.ok(sep > 0);
  assert.equal(args[sep + 1], "--json --help; rm -rf /");
  // Ensure we did not inject the spec as an earlier flag-bearing token alone.
  assert.equal(args.indexOf("--json --help; rm -rf /"), sep + 1);
});

test("resume does not pass --cd (cwd is the workspace contract)", () => {
  const { args, kind } = buildCodexArgs(
    {
      spec: "continue",
      mode: "agent",
      workspace: "D:\\other\\workspace",
      resumeThreadId: "019f64c2-4592-7213-ab3c-253dd1a1c42c",
      network: false,
    },
    { resultFile: "D:\\tmp\\o.txt", platform: "win32" }
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
        { spec: "q", mode: "ask", workspace: "/r", network: false },
        { resultFile: "/tmp/o.txt", outputSchemaFile: "/tmp/schema.json", platform: "linux" }
      ),
    /output schema is not supported in ask mode/i
  );
});

// --- Cancel ownership edge cases ---

test("cancel with threadId while active thread is still unknown is not-owned", async () => {
  const reg = createOperationRegistry();
  const lease = reg.acquire({
    threadId: null,
    cancel: async () => {},
  });
  const result = await reg.cancel({ threadId: "stale-from-previous-turn" });
  assert.equal(result.status, "not-owned");
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

test("timeout marks timedOut but not user-cancelled", async () => {
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
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutReason, "hard-cap");
  assert.equal(result.cancelled, false);
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

test("plan mode accepts JSON but warns when schema shape is wrong", async () => {
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
          filesReportedByAgent: [],
        };
      },
    }
  );
  assert.equal(result.plan, undefined);
  assert.ok(result.warnings.some((w) => /plan/i.test(w) && /schema|shape|invalid/i.test(w)));
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
          filesReportedByAgent: [],
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
