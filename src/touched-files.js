import { execFileSync } from "node:child_process";
import path from "node:path";

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true });
}

export function parsePorcelain(stdout, repoRoot) {
  const set = new Set();
  for (const raw of String(stdout || "").split("\n")) {
    if (!raw.trim()) continue;
    const rest = raw.slice(3);
    const arrow = rest.indexOf(" -> ");
    const p = (arrow !== -1 ? rest.slice(arrow + 4) : rest).trim();
    if (p) set.add(path.resolve(repoRoot, p));
  }
  return set;
}

/** Snapshot git porcelain paths; returns null when workspace is not a git repo. */
export function gitChangedSet(workspace, run = defaultRun) {
  if (!workspace) return null;
  try {
    const root = run("git", ["-C", workspace, "rev-parse", "--show-toplevel"]).trim();
    const out = run("git", [
      "-C",
      workspace,
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    return parsePorcelain(out, root);
  } catch {
    return null;
  }
}

function relativize(abs, workspace) {
  if (!workspace) return abs;
  const r = path.relative(workspace, abs);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return abs;
  return r.split(path.sep).join("/");
}

export function computeTouched({ before, after, workspace } = {}) {
  if (!after) return { files: [], source: "none" };
  const beforeSet = before || new Set();
  const out = new Set();
  for (const f of after) if (!beforeSet.has(f)) out.add(f);
  return {
    files: [...out].map((f) => relativize(f, workspace)),
    source: "git",
  };
}
