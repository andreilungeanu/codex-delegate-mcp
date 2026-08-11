import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodexArgs,
  estimateArgvChars,
  validateDelegateInput,
  PLAN_SCHEMA,
  MODES,
} from "../src/command.js";

function assertApprovalsBypassed(built) {
  assert.ok(built.args.includes("--dangerously-bypass-approvals-and-sandbox"));
}

test("validateDelegateInput defaults and resolves workspace", () => {
  const cwd = process.cwd();
  const req = validateDelegateInput(
    { spec: "do the thing" },
    { cwd }
  );
  assert.equal(req.mode, "agent");
  assert.equal(req.webSearch, true);
  assert.equal(req.fast, false);
  assert.equal(req.workspace, cwd);
  assert.equal(req.model, "gpt-5.6-terra");
  assert.equal(req.reasoningEffort, "high");
});

test("workspace must exist and be a directory", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "x", workspace: path.resolve("no-such-dir-xyz") }),
    /workspace does not exist/
  );
  assert.throws(
    () => validateDelegateInput({ spec: "x", workspace: fileURLToPath(import.meta.url) }),
    /workspace is not a directory/
  );
});

test("resume requires an explicit workspace because resume has no --cd", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "x", resumeThreadId: "tid-1" }),
    /workspace is required when resuming/
  );
  const ok = validateDelegateInput({
    spec: "x",
    resumeThreadId: "tid-1",
    workspace: process.cwd(),
  });
  assert.equal(ok.resumeThreadId, "tid-1");
});

test("reasoningEffort accepts none and max, which gpt-5.6 models take", () => {
  assert.equal(validateDelegateInput({ spec: "x", reasoningEffort: "none" }).reasoningEffort, "none");
  assert.equal(validateDelegateInput({ spec: "x", reasoningEffort: "max" }).reasoningEffort, "max");
  assert.throws(
    () => validateDelegateInput({ spec: "x", reasoningEffort: "ultra" }),
    /reasoningEffort must be one of/
  );
});

test("fast defaults off; only sets Codex service_tier when true", () => {
  const off = validateDelegateInput({ spec: "x" });
  assert.equal(off.fast, false);
  const offArgs = buildCodexArgs(
    { ...off, workspace: "/repo", webSearch: false },
    { resultFile: "/tmp/out.txt" }
  ).args;
  assert.ok(!offArgs.some((a) => String(a).includes("service_tier")));
  assert.ok(!offArgs.some((a) => String(a).includes("fast_mode")));

  const on = validateDelegateInput({ spec: "x", fast: true });
  assert.equal(on.fast, true);
  const onArgs = buildCodexArgs(
    { ...on, workspace: "/repo", webSearch: false },
    { resultFile: "/tmp/out.txt" }
  ).args;
  assert.ok(onArgs.includes('service_tier="fast"'));
  assert.ok(onArgs.includes("features.fast_mode=true"));
});

test("model and reasoningEffort overrides are preserved when user-provided", () => {
  const req = validateDelegateInput({
    spec: "x",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  });
  assert.equal(req.model, "gpt-5.6-sol");
  assert.equal(req.reasoningEffort, "xhigh");
});

test("validateDelegateInput rejects empty spec", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "" }),
    (err) => err.code === "invalid_spec"
  );
  assert.throws(
    () => validateDelegateInput({ spec: "   " }),
    (err) => err.code === "invalid_spec"
  );
  assert.throws(
    () => validateDelegateInput({}),
    (err) => err.code === "invalid_spec"
  );
});

test("webSearch defaults true in every mode and can be disabled", () => {
  for (const mode of ["agent", "plan", "ask"]) {
    assert.equal(validateDelegateInput({ spec: "x", mode }).webSearch, true);
    assert.equal(
      validateDelegateInput({ spec: "x", mode, webSearch: false }).webSearch,
      false
    );
  }
  const review = { spec: "x", mode: "review", reviewTarget: { kind: "uncommitted" } };
  assert.equal(validateDelegateInput(review).webSearch, true);
  assert.equal(validateDelegateInput({ ...review, webSearch: false }).webSearch, false);
});

test("ask gets web_search when connected", () => {
  const args = buildCodexArgs(validateDelegateInput({ spec: "q", mode: "ask" }), {
    resultFile: "/tmp/o.txt",
  }).args;
  assert.ok(args.includes('web_search="live"'));
});

test("review requires reviewTarget", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "review me", mode: "review" }),
    (err) => err.code === "invalid_review_target"
  );
  const req = validateDelegateInput({
    spec: "look for bugs",
    mode: "review",
    reviewTarget: { kind: "uncommitted" },
  });
  assert.equal(req.reviewTarget.kind, "uncommitted");
});

test("resumeThreadId is forbidden with review", () => {
  assert.throws(
    () =>
      validateDelegateInput({
        spec: "review",
        mode: "review",
        resumeThreadId: "tid-1",
        reviewTarget: { kind: "uncommitted" },
      }),
    (err) => err.code === "invalid_resume"
  );
});

test("validateDelegateInput rejects bad timeoutMs", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "x", timeoutMs: 999 }),
    (err) => err.code === "invalid_timeout"
  );
  assert.throws(
    () => validateDelegateInput({ spec: "x", timeoutMs: 86_400_001 }),
    (err) => err.code === "invalid_timeout"
  );
  assert.throws(
    () => validateDelegateInput({ spec: "x", timeoutMs: 1500.5 }),
    (err) => err.code === "invalid_timeout"
  );
  const ok = validateDelegateInput({ spec: "x", timeoutMs: 1000 });
  assert.equal(ok.timeoutMs, 1000);
});

test("validateDelegateInput rejects bad reviewTarget kinds", () => {
  assert.throws(
    () =>
      validateDelegateInput({
        spec: "r",
        mode: "review",
        reviewTarget: { kind: "unknown" },
      }),
    (err) => err.code === "invalid_review_target"
  );
  assert.throws(
    () =>
      validateDelegateInput({
        spec: "r",
        mode: "review",
        reviewTarget: { kind: "base", branch: "" },
      }),
    (err) => err.code === "invalid_review_target"
  );
  assert.throws(
    () =>
      validateDelegateInput({
        spec: "r",
        mode: "review",
        reviewTarget: { kind: "commit", sha: "  " },
      }),
    (err) => err.code === "invalid_review_target"
  );
  assert.throws(
    () =>
      validateDelegateInput({
        spec: "r",
        mode: "agent",
        reviewTarget: { kind: "uncommitted" },
      }),
    (err) => err.code === "invalid_review_target"
  );
  const base = validateDelegateInput({
    spec: "r",
    mode: "review",
    reviewTarget: { kind: "base", branch: "main" },
  });
  assert.deepEqual(base.reviewTarget, { kind: "base", branch: "main" });
  const commit = validateDelegateInput({
    spec: "r",
    mode: "review",
    reviewTarget: { kind: "commit", sha: "abc123" },
  });
  assert.deepEqual(commit.reviewTarget, { kind: "commit", sha: "abc123" });
});

test("mode matrix: approvals, schema, review subcommand, resume", () => {
  assert.deepEqual([...MODES], ["agent", "plan", "ask", "review"]);

  const agent = buildCodexArgs(
    { spec: "a", mode: "agent", workspace: "/repo", webSearch: false },
    { resultFile: "/tmp/out.txt" }
  );
  assert.equal(agent.kind, "initial");
  assertApprovalsBypassed(agent);
  assert.ok(!agent.args.includes("--output-schema"));
  assert.ok(!agent.args.includes("review"));
  assert.ok(!agent.args.includes("resume"));

  const plan = buildCodexArgs(
    { spec: "p", mode: "plan", workspace: "/repo", webSearch: false },
    { resultFile: "/tmp/out.txt", outputSchemaFile: "/tmp/schema.json" }
  );
  assert.equal(plan.kind, "initial");
  assertApprovalsBypassed(plan);
  assert.ok(plan.args.includes("--output-schema"));
  assert.ok(plan.args.includes("/tmp/schema.json"));
  assert.ok(!plan.args.includes("review"));

  const ask = buildCodexArgs(
    { spec: "q", mode: "ask", workspace: "/repo", webSearch: false },
    { resultFile: "/tmp/out.txt" }
  );
  assert.equal(ask.kind, "initial");
  assertApprovalsBypassed(ask);
  assert.ok(!ask.args.includes("--output-schema"));
  assert.ok(!ask.args.includes("review"));

  const review = buildCodexArgs(
    {
      spec: "r",
      mode: "review",
      workspace: "/repo",
      webSearch: false,
      reviewTarget: { kind: "uncommitted" },
    },
    { resultFile: "/tmp/out.txt" }
  );
  assert.equal(review.kind, "review");
  assertApprovalsBypassed(review);
  assert.ok(review.args.includes("review"));
  assert.ok(review.args.includes("--uncommitted"));
  assert.ok(!review.args.includes("--output-schema"));
  assert.ok(!review.args.includes("resume"));

  const resume = buildCodexArgs(
    {
      spec: "continue",
      mode: "agent",
      workspace: "/repo",
      resumeThreadId: "tid-resume",
      webSearch: false,
    },
    { resultFile: "/tmp/out.txt" }
  );
  assert.equal(resume.kind, "resume");
  assertApprovalsBypassed(resume);
  assert.ok(resume.args.includes("resume"));
  assert.ok(resume.args.includes("tid-resume"));
});

test("build initial agent args", () => {
  const { args, kind } = buildCodexArgs(
    {
      spec: "fix it",
      mode: "agent",
      workspace: "D:\\repo",
      webSearch: false,
    },
    { resultFile: "D:\\tmp\\out.txt" }
  );
  assert.equal(kind, "initial");
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--output-last-message"));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--skip-git-repo-check"));
  // The brief goes down stdin, so argv carries only the marker that says so.
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes("fix it"));
});

test("webSearch drives the Codex web search mode", () => {
  const off = buildCodexArgs(
    { spec: "x", mode: "agent", workspace: "/repo", webSearch: false },
    { resultFile: "/tmp/out.txt" }
  );
  assert.ok(off.args.includes('web_search="disabled"'));

  const on = buildCodexArgs(
    { spec: "x", mode: "agent", workspace: "/repo", webSearch: true },
    { resultFile: "/tmp/out.txt" }
  );
  assert.ok(on.args.includes('web_search="live"'));
});

test("plan requires schema file; review rejects schema", () => {
  assert.throws(
    () =>
      buildCodexArgs(
        { spec: "plan it", mode: "plan", workspace: "/tmp/repo", webSearch: false },
        { resultFile: "/tmp/out.txt" }
      ),
    /plan mode requires outputSchemaFile/
  );

  assert.throws(
    () =>
      buildCodexArgs(
        {
          spec: "r",
          mode: "review",
          workspace: "/tmp/repo",
          webSearch: false,
          reviewTarget: { kind: "uncommitted" },
        },
        {
          resultFile: "/tmp/out.txt",
          outputSchemaFile: "/tmp/schema.json",
        }
      ),
    /not supported in review mode/
  );
});

test("build plan args include output schema", () => {
  const { args } = buildCodexArgs(
    { spec: "plan it", mode: "plan", workspace: "/tmp/repo", webSearch: false },
    {
      resultFile: "/tmp/out.txt",
      outputSchemaFile: "/tmp/schema.json",
    }
  );
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes("/tmp/schema.json"));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(PLAN_SCHEMA.required.includes("overview"));
});

test("build review args use developer_instructions and target flags", () => {
  const { args, kind } = buildCodexArgs(
    {
      spec: "focus on auth",
      mode: "review",
      workspace: "/tmp/repo",
      webSearch: false,
      reviewTarget: { kind: "base", branch: "main" },
    },
    { resultFile: "/tmp/out.txt" }
  );
  assert.equal(kind, "review");
  assert.ok(args.includes("review"));
  assert.ok(args.includes("--base"));
  assert.ok(args.includes("main"));
  assert.ok(args.some((a) => String(a).startsWith("developer_instructions=")));

  const commit = buildCodexArgs(
    {
      spec: "focus",
      mode: "review",
      workspace: "/tmp/repo",
      webSearch: false,
      reviewTarget: { kind: "commit", sha: "deadbeef" },
    },
    { resultFile: "/tmp/out.txt" }
  );
  assert.ok(commit.args.includes("--commit"));
  assert.ok(commit.args.includes("deadbeef"));
});

test("build resume args", () => {
  const { args, kind } = buildCodexArgs(
    {
      spec: "continue",
      mode: "agent",
      workspace: "/tmp/repo",
      resumeThreadId: "019f64c2-4592-7213-ab3c-253dd1a1c42c",
      webSearch: false,
    },
    { resultFile: "/tmp/out.txt" }
  );
  assert.equal(kind, "resume");
  assert.ok(args.includes("resume"));
  assert.ok(args.includes("019f64c2-4592-7213-ab3c-253dd1a1c42c"));
  assert.ok(args.includes("--skip-git-repo-check"));
});

test("an oversized spec rides stdin instead of being refused", () => {
  const huge = "x".repeat(30_000);
  const built = buildCodexArgs(
    { spec: huge, mode: "ask", workspace: "/tmp/repo", webSearch: false },
    { resultFile: "/tmp/out.txt" }
  );
  assert.equal(built.stdin, huge);
  assert.equal(built.args.at(-1), "-");
});

test("review still refuses an oversized spec, because its brief is still argv", () => {
  const huge = "x".repeat(30_000);
  assert.throws(
    () =>
      buildCodexArgs(
        {
          spec: huge,
          mode: "review",
          workspace: "/tmp/repo",
          webSearch: false,
          reviewTarget: { kind: "uncommitted" },
        },
        { resultFile: "/tmp/out.txt" }
      ),
    (err) => err.code === "argv_too_long"
  );
});

test("a spec far past the CreateProcess limit is fine once it leaves argv", () => {
  const req = validateDelegateInput({ spec: "x".repeat(200_000), workspace: process.cwd() });
  const built = buildCodexArgs(req, { resultFile: "/tmp/o.txt" });
  assert.equal(built.stdin.length, 200_000);
  assert.ok(estimateArgvChars(built.args) < 2_000);
});
