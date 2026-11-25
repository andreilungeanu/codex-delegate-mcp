// A whole delegation as the server runs it: validation, model preflight, temp files,
// argv, the run itself over a streamed transcript, plan parsing and result shaping.
// Only the Codex binary is replaced, by a child that replays a recorded-shape transcript.
import { bench, describe } from "vitest";
import { executeDelegate } from "../src/delegate.js";
import { runCodexProcess } from "../src/run-codex.js";
import { agentTranscript, brief, CATALOG, fakeSpawn, planMessage } from "./fixtures.js";

const workspace = process.cwd();
const spec = brief(30);

function options(spawnImpl) {
  return {
    env: {},
    catalog: CATALOG,
    resolve: () => ({ command: "codex", version: "0.160.0", source: "bench", warnings: [] }),
    runProcess: (opts) => runCodexProcess({ ...opts, spawnImpl }),
    onProgress: () => {},
  };
}

const agentRun = options(
  fakeSpawn({ lines: agentTranscript({ steps: 40 }), finalMessage: "Done. All modules updated and tests pass." })
);
const planRun = options(
  fakeSpawn({ lines: agentTranscript({ steps: 10 }), finalMessage: planMessage(25) })
);

describe("executeDelegate", () => {
  bench("agent mode, 40-step turn", async () => {
    const out = await executeDelegate({ spec, workspace, mode: "agent" }, agentRun);
    if (out.status !== "completed") throw new Error(`unexpected status ${out.status}`);
  });

  bench("plan mode, 25-step plan", async () => {
    const out = await executeDelegate({ spec, workspace, mode: "plan", model: "gpt-6.2-sol" }, planRun);
    if (out.status !== "completed" || !out.plan) throw new Error(`unexpected status ${out.status}`);
  });
});
