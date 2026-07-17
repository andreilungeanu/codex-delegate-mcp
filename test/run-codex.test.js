import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { readFinalResult, runCodexProcess } from "../src/run-codex.js";

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
  assert.ok(progress.includes("thread started"));
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
  assert.match(result.warnings[0], /status=failed/);
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
    idleMs: 30_000,
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.cancelled, true);
  assert.equal(result.finalMessageAvailable, false);
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
    idleMs: 5000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.filesReportedByAgent.sort(), [absA, absB].sort());
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
    idleMs: 5000,
  });

  assert.equal(result.status, "failed");
  assert.match(result.stderrTail, /permission denied/);
  assert.ok(result.warnings.some((w) => /stderr:.*permission denied/i.test(w)));
});

test("runCodexProcess idle timeout trips before hard cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-idle-"));
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
      return child;
    },
    treeKillImpl: async () => {
      childRef.stdout.push(null);
      childRef.exitCode = 1;
      childRef.emit("close", 1);
    },
    platform: "linux",
    timeoutMs: 30_000,
    idleMs: 40,
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutReason, "idle-timeout");
  assert.equal(result.cancelled, false);
  assert.ok(result.warnings.some((w) => /Idle timeout/i.test(w)));
});
