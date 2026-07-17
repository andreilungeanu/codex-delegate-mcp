import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { readFinalResult, runCodexProcess } from "../src/run-codex.js";

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

test("runCodexProcess parses thread id and requires final file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-run-"));
  const resultFile = path.join(dir, "last.txt");

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = Readable.from([
      `${JSON.stringify({ type: "thread.started", thread_id: "tid-1" })}\n`,
      `${JSON.stringify({ type: "turn.started" })}\n`,
      `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
    ]);
    child.stderr = Readable.from([]);
    child.exitCode = null;
    child.signalCode = null;
    queueMicrotask(async () => {
      await writeFile(resultFile, "hello from codex", "utf8");
      child.exitCode = 0;
      child.emit("close", 0);
    });
    return child;
  };

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
