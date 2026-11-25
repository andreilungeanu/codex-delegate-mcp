// Input validation and argv construction, run once per delegate call before Codex spawns.
import { bench, describe } from "vitest";
import { buildCodexArgs, estimateArgvChars, validateDelegateInput } from "../src/command.js";
import { brief } from "./fixtures.js";

const workspace = process.cwd();
const spec = brief(30);
const resultFile = "/tmp/codex-delegate-bench/last-message.txt";
const outputSchemaFile = "/tmp/codex-delegate-bench/plan.schema.json";

const requests = {
  agent: { spec, workspace, mode: "agent", fast: true },
  plan: { spec, workspace, mode: "plan", model: "gpt-6.2-sol", reasoningEffort: "high" },
  resume: { spec, workspace, mode: "agent", resumeThreadId: "019a-bench-thread" },
  review: { spec, workspace, mode: "review", reviewTarget: { kind: "base", branch: "main" } },
};

describe("validateDelegateInput + buildCodexArgs", () => {
  for (const [name, raw] of Object.entries(requests)) {
    bench(name, () => {
      const request = validateDelegateInput(raw);
      buildCodexArgs(request, {
        resultFile,
        outputSchemaFile: request.mode === "plan" ? outputSchemaFile : null,
        platform: "linux",
      });
    });
  }

  // On Windows the review brief travels in argv, so the command line length is checked.
  bench("review on win32 (argv length check)", () => {
    const request = validateDelegateInput(requests.review);
    buildCodexArgs(request, { resultFile, platform: "win32" });
  });
});

const reviewArgv = buildCodexArgs(validateDelegateInput(requests.review), { resultFile, platform: "linux" }).args;

describe("estimateArgvChars", () => {
  bench("review argv with a 30-paragraph brief", () => {
    estimateArgvChars(reviewArgv);
  });
});
