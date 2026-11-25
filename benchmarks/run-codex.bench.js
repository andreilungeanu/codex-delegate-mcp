// The run layer: every Codex JSONL line passes through readline and the event reducer
// while the delegation is live, then the run is classified and its warnings built.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bench, describe } from "vitest";
import {
  createEventReducer,
  describeNonSuccessfulItem,
  readAgentError,
  readUsage,
  runCodexProcess,
} from "../src/run-codex.js";
import { agentTranscript, failedTranscript, fakeSpawn } from "./fixtures.js";

const dir = mkdtempSync(path.join(tmpdir(), "cdm-bench-run-"));
const resultFile = path.join(dir, "last-message.txt");
const args = ["exec", "--json", "--output-last-message", resultFile, "--", "-"];

const longRun = fakeSpawn({ lines: agentTranscript({ steps: 80 }), finalMessage: "Done. All modules updated and tests pass." });
const failedRun = fakeSpawn({
  lines: failedTranscript(),
  exitCode: 1,
  stderr: ["Reading additional input from stdin...\n", "ERROR: usage limit reached\n"],
});

const run = (spawnImpl) =>
  runCodexProcess({ command: "codex", args, cwd: dir, resultFile, stdin: "brief", spawnImpl, onProgress: () => {} });

const longTranscript = agentTranscript({ steps: 80 });

describe("event reducer", () => {
  // The same lines as the agent turn below, without the stream and process plumbing.
  bench("reduce an 80-step agent transcript", () => {
    const { state, handleLine } = createEventReducer({ emit: () => {} });
    for (const line of longTranscript) handleLine(line);
    if (state.turnStatus !== "completed") throw new Error(`unexpected turn status ${state.turnStatus}`);
  });
});

describe("runCodexProcess", () => {
  bench("agent turn, 80 steps of commands and edits", async () => {
    const result = await run(longRun);
    if (result.status !== "completed") throw new Error(`unexpected status ${result.status}`);
  });

  bench("turn failed after reconnect retries", async () => {
    const result = await run(failedRun);
    if (result.reason !== "agent-error") throw new Error(`unexpected reason ${result.reason}`);
  });
});

const nestedError = {
  message: JSON.stringify({ error: { message: "The 'gpt-6-nova' model is not supported when using Codex with a ChatGPT account." } }),
};
const failedItem = {
  type: "command_execution",
  command: "bash -lc \"npm test\n  -- --reporter=dot\"",
  status: "failed",
  exit_code: 1,
  error: { message: "process exited\nwith code 1" },
};
const usage = { input_tokens: 482_113, cached_input_tokens: 401_920, output_tokens: 18_204, reasoning_output_tokens: 9_870 };

describe("result helpers", () => {
  bench("readAgentError + describeNonSuccessfulItem + readUsage", () => {
    for (let i = 0; i < 100; i++) {
      readAgentError(nestedError);
      describeNonSuccessfulItem(failedItem);
      readUsage(usage);
    }
  });
});
