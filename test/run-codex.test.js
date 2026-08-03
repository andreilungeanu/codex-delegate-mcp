import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  capResultBytes,
  describeFailedItem,
  readUsage,
  meaningfulStderr,
  readAgentError,
  readFinalResult,
  runCodexProcess,
} from "../src/run-codex.js";

function fakeChild({ lines = [], exitCode = 0, writeResult } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = Readable.from(lines.map((l) => `${l}\n`));
  child.stderr = Readable.from([]);
  child.exitCode = null;
  child.signalCode = null;
  queueMicrotask(async () => {
    if (writeResult) await writeResult();
    child.exitCode = exitCode;
    child.emit("close", exitCode);
  });
  return child;
}

test("readFinalResult accepts file only on completed exit 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-final-"));
  const file = path.join(dir, "out.txt");
  await writeFile(file, "DONE", "utf8");
  const ok = await readFinalResult({ filePath: file, status: "completed", exitCode: 0 });
  assert.equal(ok.finalMessageAvailable, true);
  assert.equal(ok.result, "DONE");
  const bad = await readFinalResult({ filePath: file, status: "failed", exitCode: 1 });
  assert.equal(bad.finalMessageAvailable, false);
  assert.equal(bad.result, "");
});

test("readFinalResult reports missing file on completed exit 0", async () => {
  const missing = path.join(tmpdir(), "cdm-missing-no-such-file.txt");
  const out = await readFinalResult({
    filePath: missing,
    status: "completed",
    exitCode: 0,
  });
  assert.equal(out.finalMessageAvailable, false);
  assert.equal(out.result, "");
  assert.match(out.warnings[0], /missing or unreadable/);
});

test("runCodexProcess parses thread id and requires final file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-run-"));
  const resultFile = path.join(dir, "last.txt");

  const spawnImpl = () =>
    fakeChild({
      lines: [
        JSON.stringify({ type: "thread.started", thread_id: "tid-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ],
      writeResult: () => writeFile(resultFile, "hello from codex", "utf8"),
    });

  const progress = [];
  const result = await runCodexProcess({
    command: "codex",
    args: ["exec", "--json"],
    cwd: dir,
    resultFile,
    spawnImpl,
    platform: "linux",
    timeoutMs: 5000,
    onProgress: (m) => progress.push(m),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.threadId, "tid-1");
  assert.equal(result.finalMessageAvailable, true);
  assert.equal(result.result, "hello from codex");
  assert.ok(progress.includes("thread started: tid-1"));
});

test("runCodexProcess trips the startup deadline when Codex never speaks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-startup-"));
  const resultFile = path.join(dir, "last.txt");

  let child;
  const silentChild = () => {
    child = new EventEmitter();
    child.pid = 555;
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.exitCode = null;
    child.signalCode = null;
    return child;
  };

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: silentChild,
    // A real kill closes the process; this stands in for taskkill succeeding.
    treeKillImpl: async () => {
      child.exitCode = 1;
      child.stdout.push(null);
      child.emit("close", 1);
    },
    platform: "linux",
    startupMs: 30,
    heartbeatMs: 0,
    timeoutMs: 10_000,
  });

  assert.equal(result.reason, "startup-timeout");
  assert.equal(result.status, "interrupted");
  assert.ok(result.warnings.some((w) => /no output within 30ms/.test(w)));
});

test("a kill that never reaps the tree still settles the delegation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-kill-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 777;
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.exitCode = null;
      child.signalCode = null;
      return child;
    },
    // taskkill reports success and the tree survives — the close never arrives.
    treeKillImpl: async () => {},
    platform: "linux",
    startupMs: 20,
    heartbeatMs: 0,
    killDeadlineMs: 40,
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.reason, "startup-timeout");
  assert.ok(result.warnings.some((w) => /did not exit within 40ms/.test(w)));
});

test("a kill deadline that fires still reports a numeric exit code", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-killcode-"));
  const resultFile = path.join(dir, "last.txt");
  const edited = path.join(dir, "important.ts");
  let childRef = null;

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () => {
      childRef = new EventEmitter();
      childRef.pid = 31_337;
      childRef.stdout = new Readable({ read() {} });
      childRef.stderr = new Readable({ read() {} });
      childRef.exitCode = null;
      childRef.signalCode = null;
      childRef.stdout.push(
        JSON.stringify({ type: "thread.started", thread_id: "thr_immortal" }) + "\n"
      );
      childRef.stdout.push(JSON.stringify({ type: "turn.started" }) + "\n");
      childRef.stdout.push(
        JSON.stringify({
          type: "item.completed",
          item: { type: "file_change", changes: [{ path: edited, kind: "update" }] },
        }) + "\n"
      );
      return childRef;
    },
    // The kill reaches the pipes but the process never reports close, so the exit
    // code can only come from the kill deadline. (A tree that also holds the pipes
    // open is the drain-deadline test.)
    treeKillImpl: async () => {
      childRef.stdout.push(null);
      childRef.stderr.push(null);
    },
    platform: "linux",
    startupMs: 0,
    heartbeatMs: 0,
    timeoutMs: 40,
    killDeadlineMs: 30,
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.reason, "hard-cap");
  // null here fails the delegate output schema, which discards the whole payload.
  assert.equal(result.exitCode, 1);
  // The diagnostics that ride along are the reason this matters.
  assert.equal(result.threadId, "thr_immortal");
  assert.deepEqual(result.filesReportedByEditTools, [edited]);
  assert.ok(result.warnings.some((w) => /Hard-cap timeout/.test(w)));
  assert.ok(result.warnings.some((w) => /a process may still be running/.test(w)));
});

test("a background process holding stdout does not hold the delegation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-orphan-"));
  const resultFile = path.join(dir, "last.txt");
  let childRef = null;

  const startedAt = Date.now();
  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () => {
      childRef = new EventEmitter();
      childRef.pid = 8080;
      // Codex started a dev server that inherited stdout: the process exits, the
      // pipes stay open for the server's lifetime, so 'close' never arrives.
      childRef.stdout = new Readable({ read() {} });
      childRef.stderr = new Readable({ read() {} });
      childRef.exitCode = null;
      childRef.signalCode = null;
      childRef.stdout.push(JSON.stringify({ type: "thread.started", thread_id: "t-orphan" }) + "\n");
      childRef.stdout.push(JSON.stringify({ type: "turn.started" }) + "\n");
      childRef.stdout.push(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
      writeFile(resultFile, "started the dev server", "utf8").then(() => {
        childRef.exitCode = 0;
        childRef.emit("exit", 0, null);
      });
      return childRef;
    },
    platform: "linux",
    heartbeatMs: 0,
    timeoutMs: 30_000,
    drainMs: 100,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "t-orphan");
  assert.equal(result.result, "started the dev server");
  // The pipes are still open right now; the run must not be waiting on them.
  assert.equal(childRef.stdout.readableEnded, false);
  assert.ok(elapsed < 5000, `run took ${elapsed}ms; it should not track the orphan`);
  assert.ok(
    result.warnings.some((w) => /still holds its output open/.test(w)),
    `expected an orphan warning, got ${JSON.stringify(result.warnings)}`
  );
});

test("a first event cancels the startup deadline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-startup-ok-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [JSON.stringify({ type: "thread.started", thread_id: "tid-s" })],
        writeResult: () => writeFile(resultFile, "ok", "utf8"),
      }),
    platform: "linux",
    startupMs: 10_000,
    heartbeatMs: 0,
    timeoutMs: 5000,
  });

  assert.equal(result.status, "completed");
});

test("a turn whose tool calls all failed does not read as clean success", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-denied-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [
          JSON.stringify({ type: "thread.started", thread_id: "tid-d" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "command_execution", command: "npm test", exit_code: -1, status: "failed" },
          }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ],
        writeResult: () => writeFile(resultFile, "I ran the tests and they pass.", "utf8"),
      }),
    platform: "linux",
    heartbeatMs: 0,
    timeoutMs: 5000,
  });

  assert.equal(result.status, "completed");
  assert.ok(
    result.warnings.some((w) => /1 Codex tool call\(s\) failed/.test(w) && /npm test/.test(w)),
    `expected a failed-tool-call warning, got ${JSON.stringify(result.warnings)}`
  );
});

test("an interrupted run salvages the last streamed message as a caveat", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-salvage-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [
          JSON.stringify({ type: "thread.started", thread_id: "tid-s" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Halfway through the refactor." },
          }),
        ],
        exitCode: 1,
      }),
    platform: "linux",
    heartbeatMs: 0,
    timeoutMs: 5000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.finalMessageAvailable, false);
  assert.equal(result.result, "Halfway through the refactor.");
  assert.equal(result.resultSource, "stream-fallback");
});

test("a completed run never falls back to streamed narration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-nofall-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "thinking out loud" },
          }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ],
        writeResult: () => writeFile(resultFile, "FINAL ANSWER", "utf8"),
      }),
    platform: "linux",
    heartbeatMs: 0,
    timeoutMs: 5000,
  });

  assert.equal(result.result, "FINAL ANSWER");
  assert.equal(result.resultSource, undefined);
});

test("an oversized stream fallback is truncated, not shipped whole", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-fallback-cap-"));
  const resultFile = path.join(dir, "last.txt");
  const huge = "z".repeat(200_000);

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [
          JSON.stringify({ type: "thread.started", thread_id: "t-huge" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: huge },
          }),
        ],
        // No final file, so the stream fallback stands in — the path that used to
        // hand back 64 MB verbatim under status "completed".
        exitCode: 1,
      }),
    platform: "linux",
    heartbeatMs: 0,
    timeoutMs: 5000,
    maxResultBytes: 1000,
  });

  assert.equal(result.resultSource, "stream-fallback");
  assert.equal(Buffer.byteLength(result.result, "utf8"), 1000);
  assert.ok(
    result.warnings.some((w) => /200000 bytes, truncated to the 1000 byte cap/.test(w)),
    `expected a truncation warning, got ${JSON.stringify(result.warnings)}`
  );
});

test("capResultBytes cuts on a codepoint boundary", () => {
  // 3 bytes each: a cap of 7 has to stop at 6 rather than split the third.
  const cut = capResultBytes("€€€", 7);
  assert.equal(cut.text, "€€");
  assert.ok(!cut.text.includes("�"));
  assert.match(cut.warnings[0], /9 bytes, truncated to the 7 byte cap/);
  assert.deepEqual(capResultBytes("€€€", 9), { text: "€€€", warnings: [] });
});

test("an oversized final result file is truncated rather than discarded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-file-cap-"));
  const file = path.join(dir, "out.txt");
  await writeFile(file, "y".repeat(5000), "utf8");

  const out = await readFinalResult({
    filePath: file,
    status: "completed",
    exitCode: 0,
    maxResultBytes: 100,
  });

  // Previously: result "", finalMessageAvailable false — the answer thrown away.
  assert.equal(out.finalMessageAvailable, true);
  assert.equal(out.result, "y".repeat(100));
  assert.match(out.warnings[0], /5000 bytes, truncated to the 100 byte cap/);
});

test("readUsage keeps only the counts Codex actually reported", () => {
  assert.deepEqual(
    readUsage({ input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 }),
    { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 }
  );
  assert.equal(readUsage({}), null);
  assert.equal(readUsage(null), null);
  assert.equal(readUsage({ input_tokens: "many" }), null);
});

test("describeFailedItem names the tool and its exit code", () => {
  assert.equal(
    describeFailedItem({ type: "command_execution", command: "ls", exit_code: -1 }),
    'command_execution "ls" exit -1'
  );
  assert.equal(describeFailedItem({ type: "file_change" }), "file_change");
});

test("readAgentError unwraps the nested Codex error envelope", () => {
  const raw = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "Unsupported value: 'minimal'" },
    status: 400,
  });
  assert.equal(readAgentError({ message: raw }), "Unsupported value: 'minimal'");
  assert.equal(readAgentError("plain failure"), "plain failure");
  assert.equal(readAgentError({ message: "   " }), null);
  assert.equal(readAgentError(undefined), null);
  assert.equal(readAgentError({ message: "x".repeat(50) }, 10), `${"x".repeat(10)}…`);
});

test("meaningfulStderr drops the benign stdin notice and keeps the rest", () => {
  const stderr = "Reading additional input from stdin...\nreal failure\n";
  assert.equal(meaningfulStderr(stderr).trim(), "real failure");
  assert.equal(meaningfulStderr("Reading additional input from stdin...").trim(), "");
});

test("runCodexProcess surfaces the reason from a turn.failed event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-err-"));
  const resultFile = path.join(dir, "last.txt");
  const detail = JSON.stringify({ error: { message: "model rejected the request" } });

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [
          JSON.stringify({ type: "thread.started", thread_id: "tid-e" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({ type: "error", message: detail }),
          JSON.stringify({ type: "turn.failed", error: { message: detail } }),
        ],
        exitCode: 1,
      }),
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.agentError, "model rejected the request");
  assert.ok(result.warnings.some((w) => w === "Codex error: model rejected the request"));
});

test("runCodexProcess non-zero exit yields failed without final message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-nz-"));
  const resultFile = path.join(dir, "last.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [
          JSON.stringify({ type: "thread.started", thread_id: "tid-nz" }),
          JSON.stringify({ type: "turn.started" }),
        ],
        exitCode: 2,
        writeResult: () => writeFile(resultFile, "should be ignored", "utf8"),
      }),
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 2);
  assert.equal(result.finalMessageAvailable, false);
  assert.equal(result.result, "");
  // status and exitCode already say this; a warning repeating them is noise.
  assert.deepEqual(result.warnings, []);
});

test("runCodexProcess turn.failed yields failed status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-tf-"));
  const resultFile = path.join(dir, "last.txt");

  const progress = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    const payload = [
      JSON.stringify({ type: "thread.started", thread_id: "tid-fail" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    ].join("\n") + "\n";
    child.stdout = Readable.from([payload]);
    child.stderr = Readable.from([]);
    child.exitCode = null;
    child.signalCode = null;
    child.stdout.on("end", () => {
      setImmediate(() => {
        child.exitCode = 1;
        child.emit("close", 1);
      });
    });
    return child;
  };

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl,
    platform: "linux",
    timeoutMs: 5000,
    onProgress: (m) => progress.push(m),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.finalMessageAvailable, false);
  assert.ok(progress.includes("turn failed"));
});

test("runCodexProcess abort signal marks interrupted and cancelled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-abort-"));
  const resultFile = path.join(dir, "last.txt");
  const controller = new AbortController();
  let childRef = null;

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 9999;
    child.stdout = new Readable({
      read() {
        /* parked until closed after kill */
      },
    });
    child.stderr = Readable.from([]);
    child.exitCode = null;
    child.signalCode = null;
    childRef = child;
    queueMicrotask(() => controller.abort(new Error("cancelled")));
    return child;
  };

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    signal: controller.signal,
    spawnImpl,
    treeKillImpl: async () => {
      childRef.stdout.push(null);
      childRef.exitCode = 1;
      childRef.emit("close", 1);
    },
    platform: "linux",
    timeoutMs: 30_000,
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.reason, "cancelled");
  assert.equal(result.finalMessageAvailable, false);
});

test("runCodexProcess does not spawn for a pre-aborted signal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-preabort-"));
  const resultFile = path.join(dir, "last.txt");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let spawnCalls = 0;

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    signal: controller.signal,
    spawnImpl: () => {
      spawnCalls += 1;
      return fakeChild();
    },
  });

  assert.equal(spawnCalls, 0);
  assert.equal(result.status, "interrupted");
  assert.equal(result.reason, "cancelled");
  assert.equal(result.finalMessageAvailable, false);
  assert.equal(result.result, "");
  assert.equal(result.stderrBytes, 0);
  assert.equal(result.stderrTail, "");
  assert.deepEqual(result.warnings, []);
});

test("runCodexProcess removes abort listener after a spawn error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-spawn-error-"));
  const resultFile = path.join(dir, "last.txt");
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };

  await assert.rejects(
    () =>
      runCodexProcess({
        command: "codex",
        args: ["exec"],
        cwd: dir,
        resultFile,
        signal,
        timeoutMs: 30_000,
        spawnImpl: () => {
          const child = new EventEmitter();
          child.pid = undefined;
          child.stdout = Readable.from([]);
          child.stderr = Readable.from([]);
          queueMicrotask(() => child.emit("error", new Error("ENOENT")));
          return child;
        },
      }),
    /ENOENT/
  );
  assert.equal(listeners.size, 0);
});

test("runCodexProcess collects file_change paths", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-fc-"));
  const resultFile = path.join(dir, "last.txt");
  const absA = path.join(dir, "a.txt");
  const absB = path.join(dir, "b.txt");

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () =>
      fakeChild({
        lines: [
          JSON.stringify({ type: "thread.started", thread_id: "tid-fc" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "file_change",
              changes: [
                { path: absA, kind: "add" },
                { path: absB, kind: "update" },
              ],
            },
          }),
          JSON.stringify({ type: "turn.completed" }),
        ],
        writeResult: () => writeFile(resultFile, "ok", "utf8"),
      }),
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.filesReportedByEditTools.sort(), [absA, absB].sort());
});

test("runCodexProcess appends stderr tail on failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-err-"));
  const resultFile = path.join(dir, "last.txt");

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = Readable.from([
      JSON.stringify({ type: "thread.started", thread_id: "tid-err" }) + "\n",
    ]);
    child.stderr = new Readable({
      read() {
        this.push("sandbox boom: permission denied\n");
        this.push(null);
      },
    });
    child.exitCode = null;
    child.signalCode = null;
    child.stderr.on("end", () => {
      setImmediate(() => {
        child.exitCode = 1;
        child.emit("close", 1);
      });
    });
    return child;
  };

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl,
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.status, "failed");
  assert.match(result.stderrTail, /permission denied/);
  assert.ok(result.warnings.some((w) => /stderr:.*permission denied/i.test(w)));
});

test("runCodexProcess caps stderr by UTF-8 bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-stderr-bytes-"));
  const resultFile = path.join(dir, "last.txt");
  const stderr = "€".repeat(30_000);

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = Readable.from([]);
      child.stderr = Readable.from([stderr]);
      child.exitCode = null;
      child.signalCode = null;
      child.stderr.on("end", () => {
        child.exitCode = 1;
        child.emit("close", 1);
      });
      return child;
    },
    platform: "linux",
    timeoutMs: 5000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stderrBytes, 64 * 1024);
});

test("runCodexProcess does not time out a silent mid-turn run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-quiet-"));
  const resultFile = path.join(dir, "last.txt");
  let childRef = null;

  const result = await runCodexProcess({
    command: "codex",
    args: ["exec"],
    cwd: dir,
    resultFile,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 7777;
      child.stdout = new Readable({ read() {} });
      child.stderr = Readable.from([]);
      child.exitCode = null;
      child.signalCode = null;
      childRef = child;
      // One event, then a long silence, then a clean finish.
      childRef.stdout.push(JSON.stringify({ type: "turn.started" }) + "\n");
      setTimeout(async () => {
        childRef.stdout.push(JSON.stringify({ type: "turn.completed" }) + "\n");
        childRef.stdout.push(null);
        await writeFile(resultFile, "quiet but fine", "utf8");
        childRef.exitCode = 0;
        childRef.emit("close", 0);
      }, 120);
      return child;
    },
    platform: "linux",
    timeoutMs: 30_000,
    startupMs: 5000,
    heartbeatMs: 0,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reason, undefined);
  assert.equal(result.result, "quiet but fine");
});
