import path from "node:path";

// Attribution rule: a path is reported only via a native Codex file_change event,
// which Codex emits for its own edit tool and nothing else. Files written by a
// shell command it ran — a formatter, a codegen script, sed — arrive as
// command_execution and are deliberately absent here. Never backfill from git,
// the final message, or shell output: the orchestrator owns diff review, and the
// value of this list is that it says what Codex *itself* edited, which a diff
// against a dirty tree cannot.

function relativize(abs, workspace) {
  if (!workspace) return abs;
  const r = path.relative(workspace, abs);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return abs;
  return r.split(path.sep).join("/");
}

export function normalizeEditToolFiles(paths, workspace) {
  const abs = paths.map((p) => (workspace ? path.resolve(workspace, p) : path.resolve(p)));
  return [...new Set(abs)].map((f) => relativize(f, workspace));
}

/** Collect path strings from a Codex file_change item.changes array. */
export function pathsFromFileChangeItem(item) {
  if (!item || !Array.isArray(item.changes)) return [];
  const out = [];
  for (const change of item.changes) {
    const p = change?.path;
    if (typeof p === "string" && p.trim()) out.push(p.trim());
  }
  return out;
}
