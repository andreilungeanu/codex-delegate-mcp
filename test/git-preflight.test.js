import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightReviewTarget, isGitRepo } from "../src/git-preflight.js";

/**
 * `answers` maps a joined argv to true (exit 0), false (git says no), a string
 * (exit 0 with that stdout), or "missing" (no git binary at all).
 */
function fakeGit(answers) {
  const calls = [];
  return {
    calls,
    execFileImpl: async (_cmd, args) => {
      const key = args.join(" ");
      calls.push(key);
      const answer = key in answers ? answers[key] : false;
      if (answer === "missing") {
        const err = new Error("spawn git ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      if (answer === false) {
        const err = new Error("git said no");
        err.code = 1;
        throw err;
      }
      return { stdout: typeof answer === "string" ? answer : "", stderr: "" };
    },
  };
}

const REPO = { "rev-parse --git-dir": ".git" };

test("preflight passes a repository with a local base branch", async () => {
  const git = fakeGit({ ...REPO, "rev-parse --verify --quiet main^{commit}": "abc123" });
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "base", branch: "main" },
    execFileImpl: git.execFileImpl,
  });
  assert.equal(git.calls.length, 2);
});

test("preflight accepts a base branch that only exists on a remote", async () => {
  // Every CI checkout, and any repo whose local base was deleted after a merge.
  // Codex resolves `main` to `origin/main`; refusing it would block a review that works.
  const git = fakeGit({
    ...REPO,
    remote: "origin\nupstream\n",
    "rev-parse --verify --quiet origin/main^{commit}": "abc123",
  });
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "base", branch: "main" },
    execFileImpl: git.execFileImpl,
  });
  assert.deepEqual(git.calls, [
    "rev-parse --git-dir",
    "rev-parse --verify --quiet main^{commit}",
    "remote",
    "rev-parse --verify --quiet origin/main^{commit}",
  ]);
});

test("preflight rejects a base branch that resolves nowhere, local or remote", async () => {
  const git = fakeGit({ ...REPO, remote: "origin\n" });
  await assert.rejects(
    () =>
      preflightReviewTarget({
        workspace: "/repo",
        reviewTarget: { kind: "base", branch: "no-such-branch-xyz" },
        execFileImpl: git.execFileImpl,
      }),
    (err) =>
      err.code === "invalid_review_target" &&
      /no-such-branch-xyz/.test(err.message) &&
      /any remote/.test(err.message)
  );
  assert.ok(git.calls.includes("rev-parse --verify --quiet origin/no-such-branch-xyz^{commit}"));
});

test("preflight does not reject when the remotes cannot be listed", async () => {
  // Nothing here proved the ref unresolvable, so nothing here gets to refuse it.
  const git = fakeGit({ ...REPO });
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "base", branch: "main" },
    execFileImpl: git.execFileImpl,
  });
});

test("preflight rejects a workspace that is not a repository", async () => {
  const git = fakeGit({});
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

test("preflight rejects a commit sha that does not resolve, without guessing at remotes", async () => {
  const git = fakeGit({ ...REPO });
  await assert.rejects(
    () =>
      preflightReviewTarget({
        workspace: "/repo",
        reviewTarget: { kind: "commit", sha: "deadbeef" },
        execFileImpl: git.execFileImpl,
      }),
    (err) => err.code === "invalid_review_target"
  );
  assert.ok(!git.calls.includes("remote"));
});

test("preflight blocks nothing when git itself cannot be run", async () => {
  const git = fakeGit({ "rev-parse --git-dir": "missing" });
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "base", branch: "main" },
    execFileImpl: git.execFileImpl,
  });
  assert.equal(git.calls.length, 1);
});

test("preflight only checks a ref when the target names one", async () => {
  const git = fakeGit(REPO);
  await preflightReviewTarget({
    workspace: "/repo",
    reviewTarget: { kind: "uncommitted" },
    execFileImpl: git.execFileImpl,
  });
  assert.deepEqual(git.calls, ["rev-parse --git-dir"]);
});

test("isGitRepo asks git rather than looking for a .git entry", async () => {
  const inside = fakeGit(REPO);
  assert.equal(await isGitRepo("/repo/src", inside.execFileImpl), true);
  assert.deepEqual(inside.calls, ["rev-parse --git-dir"]);

  const outside = fakeGit({});
  assert.equal(await isGitRepo("/tmp", outside.execFileImpl), false);

  const noGit = fakeGit({ "rev-parse --git-dir": "missing" });
  assert.equal(await isGitRepo("/repo", noGit.execFileImpl), null);
});
