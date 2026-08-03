import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightReviewTarget } from "../src/git-preflight.js";

function fakeGit(answers) {
  const calls = [];
  return {
    calls,
    execFileImpl: async (_cmd, args) => {
      calls.push(args.join(" "));
      const key = args[1];
      if (answers[key] === false) {
        const err = new Error("git said no");
        err.code = 1;
        throw err;
      }
      if (answers[key] === "missing") {
        const err = new Error("spawn git ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return { stdout: "", stderr: "" };
    },
  };
}

test("preflight passes a real repository and target through", async () => {
  const git = fakeGit({ "--git-dir": true, "--verify": true });
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "base", branch: "main" },
    execFileImpl: git.execFileImpl,
  });
  assert.equal(git.calls.length, 2);
  assert.match(git.calls[1], /main\^\{commit\}/);
});

test("preflight rejects a workspace that is not a repository", async () => {
  const git = fakeGit({ "--git-dir": false });
  await assert.rejects(
    () =>
      preflightReviewTarget({
        workspace: "/not-a-repo",
        reviewTarget: { kind: "uncommitted" },
        execFileImpl: git.execFileImpl,
      }),
    (err) => err.code === "invalid_workspace"
  );
});

test("preflight rejects a base branch that does not resolve", async () => {
  const git = fakeGit({ "--git-dir": true, "--verify": false });
  await assert.rejects(
    () =>
      preflightReviewTarget({
        workspace: "/repo",
        reviewTarget: { kind: "base", branch: "no-such-branch-xyz" },
        execFileImpl: git.execFileImpl,
      }),
    (err) => err.code === "invalid_review_target" && /no-such-branch-xyz/.test(err.message)
  );
});

test("preflight rejects a commit sha that does not resolve", async () => {
  const git = fakeGit({ "--git-dir": true, "--verify": false });
  await assert.rejects(
    () =>
      preflightReviewTarget({
        workspace: "/repo",
        reviewTarget: { kind: "commit", sha: "deadbeef" },
        execFileImpl: git.execFileImpl,
      }),
    (err) => err.code === "invalid_review_target"
  );
});

test("preflight blocks nothing when git itself cannot be run", async () => {
  const git = fakeGit({ "--git-dir": "missing" });
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "base", branch: "main" },
    execFileImpl: git.execFileImpl,
  });
  assert.equal(git.calls.length, 1);
});

test("preflight only checks a ref when the target names one", async () => {
  const git = fakeGit({ "--git-dir": true });
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "uncommitted" },
    execFileImpl: git.execFileImpl,
  });
  assert.equal(git.calls.length, 1);
});
