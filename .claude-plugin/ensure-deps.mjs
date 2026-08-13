// Install runtime dependencies on SessionStart when the plugin cache has none.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The SDK rather than node_modules: a half-finished install leaves the directory
// behind, and a bare existence check would then skip the repair on every session
// while the server keeps failing to import.
if (existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk"))) {
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
    // npm.cmd is a batch file, and Node refuses to spawn one without a shell — so
    // the first session after a plugin install fails on Windows, before doctor
    // exists to say why. The argument list is fixed and carries no user input, so
    // the reason this project keeps shell off for `codex exec` does not apply.
    shell: process.platform === "win32",
  });
} catch (err) {
  console.error(`codex-delegate-mcp: dependency install failed: ${err?.message || err}`);
  process.exit(1);
}
