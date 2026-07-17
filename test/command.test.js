import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexArgs,
  validateDelegateInput,
  PLAN_SCHEMA,
} from "../src/command.js";

test("validateDelegateInput defaults and resolves workspace", () => {
  const req = validateDelegateInput(
    { spec: "do the thing" },
    { cwd: "D:\\work\\repo" }
  );
  assert.equal(req.mode, "agent");
  assert.equal(req.network, false);
  assert.equal(req.workspace, "D:\\work\\repo");
});

test("network only allowed in agent mode", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "x", mode: "ask", network: true }),
    /network/
  );
});

test("review requires reviewTarget", () => {
  assert.throws(
    () => validateDelegateInput({ spec: "review me", mode: "review" }),
    /reviewTarget/
  );
  const req = validateDelegateInput({
    spec: "look for bugs",
    mode: "review",
    reviewTarget: { kind: "uncommitted" },
  });
  assert.equal(req.reviewTarget.kind, "uncommitted");
});

test("build initial agent args", () => {
  const { args, kind, sandbox } = buildCodexArgs(
    {
      spec: "fix it",
      mode: "agent",
      workspace: "D:\\repo",
      network: false,
    },
    { resultFile: "D:\\tmp\\out.txt", platform: "win32" }
  );
  assert.equal(kind, "initial");
  assert.equal(sandbox, "workspace-write");
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--output-last-message"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args.at(-1), "fix it");
});

test("build plan args include output schema", () => {
  const { args } = buildCodexArgs(
    { spec: "plan it", mode: "plan", workspace: "/tmp/repo", network: false },
    {
      resultFile: "/tmp/out.txt",
      outputSchemaFile: "/tmp/schema.json",
      platform: "linux",
    }
  );
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes("/tmp/schema.json"));
  assert.ok(args.includes("read-only"));
  assert.ok(PLAN_SCHEMA.required.includes("overview"));
});

test("build review args use developer_instructions and target flags", () => {
  const { args, kind } = buildCodexArgs(
    {
      spec: "focus on auth",
      mode: "review",
      workspace: "/tmp/repo",
      network: false,
      reviewTarget: { kind: "base", branch: "main" },
    },
    { resultFile: "/tmp/out.txt", platform: "linux" }
  );
  assert.equal(kind, "review");
  assert.ok(args.includes("review"));
  assert.ok(args.includes("--base"));
  assert.ok(args.includes("main"));
  assert.ok(args.some((a) => String(a).startsWith("developer_instructions=")));
});

test("build resume args", () => {
  const { args, kind } = buildCodexArgs(
    {
      spec: "continue",
      mode: "agent",
      workspace: "/tmp/repo",
      resumeThreadId: "019f64c2-4592-7213-ab3c-253dd1a1c42c",
      network: false,
    },
    { resultFile: "/tmp/out.txt", platform: "linux" }
  );
  assert.equal(kind, "resume");
  assert.ok(args.includes("resume"));
  assert.ok(args.includes("019f64c2-4592-7213-ab3c-253dd1a1c42c"));
});
