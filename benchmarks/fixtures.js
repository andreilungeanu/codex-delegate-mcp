// Shared inputs for the benchmarks: a stand-in for the Codex child process and the JSONL
// transcripts it streams, shaped like what `codex exec --json` prints on real runs.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { writeFileSync } from "node:fs";

/** Pipe-sized chunks, so readline sees lines split across reads as it does from a real child. */
const CHUNK = 64 * 1024;

function toChunks(lines) {
  const text = lines.map((line) => `${line}\n`).join("");
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
  return chunks;
}

const testOutput = (i) =>
  Array.from({ length: 40 }, (_, n) => `  ✔ suite ${i} case ${n} passes with the expected result (${n}ms)`).join("\n");

/**
 * A long agent turn: reasoning, shell commands with their output, edits through the
 * native edit tool, MCP calls, web searches and a couple of Codex notices.
 */
export function agentTranscript({ steps = 80, threadId = "019a-bench-thread" } = {}) {
  const events = [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_n0", type: "error", message: "Model metadata for `gpt-6-luna` not found." } },
  ];
  for (let i = 0; i < steps; i++) {
    const id = (k) => `item_${i}_${k}`;
    events.push({
      type: "item.completed",
      item: { id: id("r"), type: "reasoning", text: `**Inspecting module ${i}**\n\nChecking how the handler treats edge case ${i}.` },
    });
    const command = `bash -lc "npm test -- test/module-${i}.test.js\n  && git status --short"`;
    events.push({ type: "item.started", item: { id: id("c"), type: "command_execution", command, status: "in_progress" } });
    events.push({
      type: "item.completed",
      item: {
        id: id("c"),
        type: "command_execution",
        command,
        aggregated_output: testOutput(i),
        exit_code: i % 9 === 0 ? 1 : 0,
        status: i % 9 === 0 ? "failed" : "completed",
      },
    });
    const changes = [
      { path: `/work/repo/src/module-${i}.js`, kind: "update" },
      { path: `/work/repo/test/module-${i}.test.js`, kind: i % 4 === 0 ? "add" : "update" },
    ];
    events.push({ type: "item.started", item: { id: id("f"), type: "file_change", changes, status: "in_progress" } });
    events.push({ type: "item.completed", item: { id: id("f"), type: "file_change", changes, status: "completed" } });
    if (i % 5 === 0) {
      events.push({ type: "item.started", item: { id: id("m"), type: "mcp_tool_call", server: "docs", tool: "search", status: "in_progress" } });
      events.push({ type: "item.completed", item: { id: id("m"), type: "mcp_tool_call", server: "docs", tool: "search", status: "completed" } });
    }
    if (i % 10 === 0) {
      events.push({ type: "item.completed", item: { id: id("w"), type: "web_search", query: `node readline crlfDelay ${i}` } });
    }
  }
  events.push({ type: "item.completed", item: { id: "item_msg", type: "agent_message", text: "Done. All modules updated and tests pass." } });
  events.push({
    type: "turn.completed",
    usage: { input_tokens: 482_113, cached_input_tokens: 401_920, output_tokens: 18_204, reasoning_output_tokens: 9_870 },
  });
  return events.map((event) => JSON.stringify(event));
}

/** A turn that retries through reconnect notices and then fails on a nested API error. */
export function failedTranscript({ retries = 5 } = {}) {
  const events = [{ type: "thread.started", thread_id: "019a-bench-failed" }, { type: "turn.started" }];
  for (let n = 1; n <= retries; n++) {
    events.push({ type: "error", message: `Reconnecting... ${n}/${retries}` });
  }
  const nested = JSON.stringify({
    error: { type: "usage_limit_reached", message: "You've hit your usage limit. Try again in 2 hours 13 minutes." },
  });
  events.push({ type: "turn.failed", error: { message: nested } });
  return events.map((event) => JSON.stringify(event));
}

/**
 * Builds a `spawnImpl` for runCodexProcess. Each spawn streams the transcript on stdout,
 * writes the final-message file like `--output-last-message`, and closes once stdout ends.
 */
export function fakeSpawn({ lines, exitCode = 0, finalMessage = "", stderr = [] }) {
  const chunks = toChunks(lines);
  return (_command, args) => {
    const resultFile = args[args.indexOf("--output-last-message") + 1];
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = Readable.from(chunks);
    child.stderr = Readable.from(stderr);
    // Written synchronously, as Codex has finished writing it by the time it exits; an
    // async write here would add a thread-pool round trip the real bridge never waits on.
    if (finalMessage) writeFileSync(resultFile, finalMessage, "utf8");
    child.stdout.once("end", () => {
      child.exitCode = exitCode;
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

const TO_MAX = ["low", "medium", "high", "xhigh", "max"];

/** What `codex debug models` reports, reduced to what the model preflight reads. */
export const CATALOG = [
  ["gpt-6-astra", [...TO_MAX, "ultra"]],
  ["gpt-6.2-sol", [...TO_MAX, "ultra"]],
  ["gpt-6-luna", TO_MAX],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
].map(([slug, efforts]) => ({
  slug,
  visibility: "list",
  supported_reasoning_levels: efforts.map((effort) => ({ effort })),
}));

/** A brief of the size an orchestrating agent writes: goal, scope, decisions, acceptance criteria. */
export function brief(paragraphs = 30) {
  return Array.from(
    { length: paragraphs },
    (_, i) =>
      `${i + 1}. In src/module-${i}.js, replace the callback-based "load" with async/await; keep the "onError" contract and the C:\\Users\\dev\\repo path handling exactly as it is. Acceptance: npm test passes.`
  ).join("\n");
}

/** A plan-mode final message that satisfies the plan schema. */
export function planMessage(steps = 25) {
  return JSON.stringify({
    overview: "Migrate src/api from callbacks to async/await in small, test-backed steps.",
    steps: Array.from({ length: steps }, (_, i) => ({
      title: `Convert module ${i}`,
      detail: `Rewrite src/api/module-${i}.js to async/await, update its callers, and adjust test/module-${i}.test.js.`,
    })),
  });
}
