import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `codex exec review` treats a missing repository or an unresolvable base as
 * something to explain in its final message: the turn completes, no tool call
 * fails, and the bridge has nothing to hand back but prose the caller was told it
 * could skim. Both are decidable before spawning, so they are decided here.
 *
 * A git that will not run at all answers nothing and therefore blocks nothing —
 * refusing a run because the check itself is unavailable would be worse than the
 * failure it guards against.
 */
export async function preflightReviewTarget({
  workspace,
  reviewTarget,
  execFileImpl = execFileAsync,
} = {}) {
  if (!reviewTarget || !workspace) return;
  const git = gitRunner(workspace, execFileImpl);

  const repo = await git(["rev-parse", "--git-dir"]);
  if (repo.status === "unknown") return;
  if (repo.status === "no") {
    throw bad(
      "invalid_workspace",
      `review needs a git repository, and ${workspace} is not one. Codex would run the review anyway and report that it found nothing to inspect.`
    );
  }

  if (reviewTarget.kind === "base") {
    await requireResolvableBase(git, workspace, reviewTarget.branch);
  } else if (reviewTarget.kind === "commit") {
    await requireResolvable(git, workspace, reviewTarget.sha, "sha");
  }
}

/**
 * Codex resolves a bare branch name against the remotes too — `main` finds
 * `origin/main` in a checkout that has no local `main`, which is every CI clone
 * and any repo whose base branch was deleted after a merge. Checking only local
 * refs would refuse reviews Codex performs perfectly well, and a guard stricter
 * than the thing it guards is worse than no guard: S2 was a useless answer, this
 * would be no answer at all, with nothing telling the caller to retry.
 *
 * This is a model of someone else's resolution rules, so it is biased permissive
 * on purpose: reject only a ref that nothing here could resolve.
 */
async function requireResolvableBase(git, workspace, branch) {
  if ((await git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`])).status !== "no") {
    return;
  }
  const remotes = await git(["remote"]);
  if (remotes.status !== "yes") return;
  for (const remote of remotes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const qualified = `${remote}/${branch}^{commit}`;
    if ((await git(["rev-parse", "--verify", "--quiet", qualified])).status !== "no") return;
  }
  throw bad(
    "invalid_review_target",
    `reviewTarget.branch "${branch}" does not resolve to a commit in ${workspace}, locally or on any remote.`
  );
}

async function requireResolvable(git, workspace, ref, field) {
  if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).status === "no") {
    throw bad(
      "invalid_review_target",
      `reviewTarget.${field} "${ref}" does not resolve to a commit in ${workspace}.`
    );
  }
}

/** Reports whether `workspace` is inside a work tree, or null when git cannot say. */
export async function isGitRepo(workspace, execFileImpl = execFileAsync) {
  if (!workspace) return null;
  const { status } = await gitRunner(workspace, execFileImpl)(["rev-parse", "--git-dir"]);
  return status === "unknown" ? null : status === "yes";
}

function gitRunner(workspace, execFileImpl) {
  return async (args) => {
    try {
      const { stdout } = await execFileImpl("git", args, {
        cwd: workspace,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: false,
      });
      return { status: "yes", stdout: String(stdout ?? "") };
    } catch (err) {
      // No git binary is "cannot say"; anything else is git saying no.
      return { status: err?.code === "ENOENT" ? "unknown" : "no", stdout: "" };
    }
  };
}

function bad(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
