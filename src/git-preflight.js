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

  const git = async (args) => {
    try {
      await execFileImpl("git", args, {
        cwd: workspace,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: false,
      });
      return "yes";
    } catch (err) {
      // No git binary is "cannot say"; anything else is git saying no.
      if (err?.code === "ENOENT") return "unknown";
      return "no";
    }
  };

  const repo = await git(["rev-parse", "--git-dir"]);
  if (repo === "unknown") return;
  if (repo === "no") {
    throw bad(
      "invalid_workspace",
      `review needs a git repository, and ${workspace} is not one. Codex would run the review anyway and report that it found nothing to inspect.`
    );
  }

  const ref =
    reviewTarget.kind === "base"
      ? reviewTarget.branch
      : reviewTarget.kind === "commit"
        ? reviewTarget.sha
        : null;
  if (!ref) return;

  if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) === "no") {
    throw bad(
      "invalid_review_target",
      `reviewTarget.${reviewTarget.kind === "base" ? "branch" : "sha"} "${ref}" does not resolve to a commit in ${workspace}.`
    );
  }
}

function bad(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
