import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskStore, runAsTask } from "../src/tasks.js";

const HOUR = 60 * 60 * 1000;

function clockedStore(opts) {
  let t = Date.parse("2026-11-24T00:00:00Z");
  const store = createTaskStore({ now: () => t, ...opts });
  return { store, advance: (ms) => { t += ms; } };
}

test("a task's thread is still found by its id once the task itself is dropped", () => {
  const { store, advance } = clockedStore();
  const first = store.create();
  first.threadId = "thread-first";
  store.add(first);
  store.finish(first, { result: {} });
  assert.equal(store.threadOf(first.taskId), "thread-first");
  advance(HOUR + 1);
  assert.equal(store.get(first.taskId), undefined);
  assert.equal(store.threadOf(first.taskId), "thread-first");
  assert.equal(store.threadOf("not-a-task"), undefined);
  assert.equal(store.threadOf(undefined), undefined);
});

test("a finished task is kept for an hour after it ends and a working one is never dropped", () => {
  const { store, advance } = clockedStore();
  const working = store.create();
  const done = store.create();
  store.add(working);
  store.add(done);
  advance(5 * HOUR);
  store.finish(done, { result: { content: [] } });
  advance(HOUR);
  assert.equal(store.get(done.taskId)?.status, "completed");
  advance(1);
  assert.equal(store.get(done.taskId), undefined);
  advance(100 * HOUR);
  assert.equal(store.get(working.taskId)?.status, "working");
});

test("every task finished within the hour is kept, however many finished", () => {
  const { store, advance } = clockedStore();
  const tasks = Array.from({ length: 150 }, () => { const task = store.create(); store.add(task); return task; });
  for (const task of tasks) { advance(1); store.finish(task, { result: {} }); }
  assert.deepEqual(tasks.filter((task) => !store.get(task.taskId)), []);
});

test("a task's ttlMs is null while it works and counts from its creation once it ends", () => {
  const { store, advance } = clockedStore();
  const task = store.create();
  store.add(task);
  assert.equal(store.view(task).ttlMs, null);
  advance(90_000);
  store.finish(task, { result: {} });
  assert.equal(store.view(task).ttlMs, 90_000 + HOUR);
});

test("pollIntervalMs is 3 s for a task's first minute and 10 s after", () => {
  const { store, advance } = clockedStore();
  const task = store.create();
  store.add(task);
  assert.equal(store.view(task).pollIntervalMs, 3000);
  advance(59_999);
  assert.equal(store.view(task).pollIntervalMs, 3000);
  advance(1);
  assert.equal(store.view(task).pollIntervalMs, 10000);
});

test("a failed task carries an internal error and a cancelled one keeps its status when the run ends", () => {
  const { store } = clockedStore();
  const failed = store.create();
  store.add(failed);
  store.finish(failed, { error: new Error("boom") });
  assert.deepEqual(store.view(failed).error, { code: -32603, message: "boom" });
  const cancelled = store.create();
  cancelled.threadId = "tid-x";
  store.add(cancelled);
  store.cancel(cancelled);
  assert.equal(cancelled.ac.signal.aborted, true);
  store.finish(cancelled, { result: { content: [] } });
  const view = store.view(cancelled);
  assert.equal(view.status, "cancelled");
  assert.equal(view.result, undefined);
  assert.equal(view.statusMessage, "cancelled; resume with resumeThreadId tid-x");
});

test("a task cancelled before Codex started a thread names no thread to resume", () => {
  const { store } = clockedStore();
  const task = store.create();
  store.add(task);
  store.cancel(task);
  assert.equal(store.view(task).statusMessage, "cancelled");
});

test("a cancel after Codex exited leaves the decided result and still stops the run's processes", () => {
  const { store } = clockedStore();
  const task = store.create();
  store.add(task);
  task.runDecided = true;
  store.cancel(task);
  assert.equal(task.ac.signal.aborted, true);
  assert.equal(store.view(task).status, "working");
  store.finish(task, { result: { content: [{ type: "text", text: "done" }] } });
  assert.equal(store.view(task).status, "completed");
});

test("a cancelled task names a resume that started a fresh thread and a tree the kill did not end, not the run's result", async () => {
  const store = createTaskStore();
  const fresh = "resuming tid-old started a fresh thread; none of its earlier context carried over.";
  const unseen = "Codex did not exit within 10000ms of being killed; a process may still be running.";
  let end;
  let reportUnseen = (_note) => {};
  const answer = await runAsTask({
    run: ({ onThreadStarted, onUnseenExit }) => {
      onThreadStarted("tid-new", fresh);
      reportUnseen = onUnseenExit;
      return new Promise((resolve) => { end = resolve; });
    },
    store,
  });
  const task = store.get(answer.taskId);
  store.cancel(task);
  assert.equal(task.statusMessage, `cancelled; resume with resumeThreadId tid-new. Note: ${fresh}`);
  reportUnseen(unseen);
  end({ content: [{ type: "text", text: JSON.stringify({ status: "interrupted", reason: "cancelled" }) }] });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.view(task).statusMessage, `cancelled; resume with resumeThreadId tid-new. Note: ${fresh} Note: ${unseen}`);
});

test("a run that fails before Codex starts a thread rejects runAsTask instead of creating a task", async () => {
  const store = createTaskStore();
  await assert.rejects(runAsTask({ run: async () => { throw new Error("setup failed"); }, store }), /setup failed/);
});

test("a run that settles before Codex starts a thread answers with its own result", async () => {
  const store = createTaskStore();
  const result = { content: [{ type: "text", text: "invalid_model" }], isError: true };
  assert.equal(await runAsTask({ run: async () => result, store }), result);
});

test("a run that throws after Codex started a thread leaves the task failed with an internal error", async () => {
  const store = createTaskStore();
  let fail;
  const answer = await runAsTask({
    run: ({ onThreadStarted }) => { onThreadStarted("tid-x"); return new Promise((_, reject) => { fail = reject; }); },
    store,
  });
  assert.equal(answer.resultType, "task");
  fail(new Error("boom"));
  await new Promise((r) => setImmediate(r));
  const view = store.view(store.get(answer.taskId));
  assert.equal(view.status, "failed");
  assert.deepEqual(view.error, { code: -32603, message: "boom" });
});

test("the run's delegation id is the task id, so cancel reaches the run by it", async () => {
  const store = createTaskStore();
  let delegationId;
  const answer = await runAsTask({
    run: (over) => { delegationId = over.delegationId; over.onThreadStarted("tid-x"); return new Promise(() => {}); },
    store,
  });
  assert.equal(delegationId, answer.taskId);
});

test("the request's cancellation no longer reaches a run once its task is answered", async () => {
  const store = createTaskStore();
  const request = new AbortController();
  let runSignal;
  const answer = await runAsTask({
    run: ({ signal, onThreadStarted }) => { runSignal = signal; onThreadStarted("tid-x"); return new Promise(() => {}); },
    signal: request.signal,
    store,
  });
  request.abort();
  assert.equal(runSignal.aborted, false);
  assert.equal(store.get(answer.taskId)?.status, "working");
});

test("a request cancelled as Codex starts its thread gets the run's own result, not a task", async () => {
  const store = createTaskStore();
  const request = new AbortController();
  const answer = await runAsTask({
    run: async ({ signal, onThreadStarted }) => {
      request.abort();
      onThreadStarted("tid-x");
      await new Promise((r) => setTimeout(r, 20));
      return { content: [{ type: "text", text: `aborted: ${signal.aborted}` }] };
    },
    signal: request.signal,
    store,
  });
  assert.equal(answer.resultType, undefined);
  assert.equal(answer.content[0].text, "aborted: true");
});

test("progress goes to the request until the task is answered, and to the task's status after", async () => {
  const store = createTaskStore();
  const notified = [];
  let progress;
  const answer = await runAsTask({
    run: ({ onProgress, onThreadStarted }) => {
      progress = onProgress;
      onProgress("delegation id: x");
      onThreadStarted("tid-x");
      return new Promise(() => {});
    },
    notify: (m) => notified.push(m),
    store,
  });
  progress("turn started");
  assert.deepEqual(notified, ["delegation id: x"]);
  assert.equal(store.view(store.get(answer.taskId)).statusMessage, "turn started");
});
