// Install runtime dependencies on SessionStart when the plugin cache has none.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Every declared dependency, and the package.json inside each rather than the
// directory holding it: a half-finished install leaves directories behind, and a
// bare existence check would then skip the repair on every session while the server
// keeps failing to import. Reading the list keeps a later dependency covered too.
let complete = false;
try {
  const { dependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  complete = Object.keys(dependencies || {}).every((name) =>
    existsSync(join(root, "node_modules", name, "package.json"))
  );
} catch {
  // An unreadable manifest is no reason to trust the tree. Install, and let npm report.
}
if (complete) {
  process.exit(0);
}

const install = ["install", "--omit=dev", "--no-audit", "--no-fund"];
const win32 = process.platform === "win32";
try {
  // On win32 one command line and no args array: Node 24 warns (DEP0190) on args under shell:true.
  execFileSync(win32 ? ["npm.cmd", ...install].join(" ") : "npm", win32 ? [] : install, {
    cwd: root,
    // npm's stdout to stderr: Claude Code adds a SessionStart hook's stdout to the session context.
    stdio: ["ignore", 2, "inherit"],
    // npm.cmd is a batch file, which Node spawns only through a shell (EINVAL otherwise). The
    // arguments are fixed and carry no user input, so the reason `codex exec` runs without a
    // shell does not apply.
    shell: win32,
  });
} catch (err) {
  console.error(`codex-delegate-mcp: dependency install failed: ${err?.message || err}`);
  process.exit(1);
}
