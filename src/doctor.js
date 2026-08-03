import process from "node:process";
import { execFile } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { refreshCodex, MIN_VERSION, clearCodexCache } from "./resolve-codex.js";
import { resolveWindowsSandbox, WINDOWS_SANDBOX_MODES } from "./command.js";
import { VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

export async function runDoctor({
  deep = false,
  workspace = process.cwd(),
  resolve = refreshCodex,
  env = process.env,
  getClientInfo,
  execFileImpl = execFileAsync,
  platform = process.platform,
} = {}) {
  const warnings = [];
  let codex = { found: false };
  try {
    const resolved = resolve({ env });
    codex = {
      found: true,
      command: resolved.command,
      source: resolved.source,
      version: resolved.version,
    };
    // Resolution notes describe the resolver working, and the loudest of them fires
    // on every correctly-configured Windows machine. Left in `warnings` they make
    // the field never-empty, which is exactly what teaches you to stop reading it.
    if (resolved.warnings?.length) codex.notes = [...resolved.warnings];
  } catch (err) {
    codex = {
      found: false,
      error: err?.message || String(err),
      code: err?.code,
    };
  }

  const client = (() => {
    try {
      const info = getClientInfo?.() || {};
      return {
        name: info.version?.name ?? null,
        version: info.version?.version ?? null,
        capabilities: info.capabilities || {},
      };
    } catch {
      return { name: null, version: null, capabilities: {} };
    }
  })();

  const login = await probeLogin(codex.found ? codex.command : null, execFileImpl);
  const recursion = {
    depth: env.CODEX_DELEGATE_DEPTH ?? null,
    active: Boolean(env.CODEX_DELEGATE_DEPTH && String(env.CODEX_DELEGATE_DEPTH).trim()),
  };

  const sandbox = describeSandbox(env, warnings, platform);

  const out = {
    plugin: { version: VERSION, name: "codex-delegate-mcp" },
    client,
    codex,
    versionGate: { minimum: MIN_VERSION, status: codex.found ? "ok" : "unresolved" },
    login,
    recursionGuard: recursion,
    workspace: describeWorkspace(workspace, warnings),
    sandbox,
    runtime: {
      node: process.versions.node,
      platform,
      arch: process.arch,
      cwd: process.cwd(),
      transport: "stdio",
    },
    warnings,
  };

  if (deep) {
    out.deep = await runDeepSmoke({ codex, execFileImpl });
  }

  return out;
}

/**
 * The workspace argument used to be echoed back and otherwise ignored, so a typo
 * looked healthy here and failed on the next delegate call. `review` additionally
 * needs a repository, which is worth saying before a review is attempted.
 */
function describeWorkspace(workspace, warnings) {
  const out = { path: workspace };
  let stat = null;
  try {
    stat = statSync(workspace);
  } catch {}
  out.exists = Boolean(stat);
  out.isDirectory = Boolean(stat?.isDirectory());
  if (!out.exists) {
    warnings.push(`workspace does not exist: ${workspace}`);
  } else if (!out.isDirectory) {
    warnings.push(`workspace is not a directory: ${workspace}`);
  } else {
    out.isGitRepo = existsSync(path.join(workspace, ".git"));
  }
  return out;
}

/**
 * Only the two modes that break anything are worth a warning. `elevated` cannot
 * spawn its helper on a normal session and fails every shell command in every
 * mode; `off` degrades workspace-write to read-only. Both still report the run as
 * completed, so nothing downstream will say it for us.
 */
function describeSandbox(env, warnings, platform) {
  if (platform !== "win32") return { platform };
  const raw = env.CODEX_DELEGATE_WINDOWS_SANDBOX;
  const { sandbox, warnings: modeWarnings } = resolveWindowsSandbox(raw, { platform: "win32" });
  warnings.push(...modeWarnings);
  if (sandbox === "elevated") {
    warnings.push(
      'CODEX_DELEGATE_WINDOWS_SANDBOX="elevated" only works from an elevated session. On a normal one Codex cannot spawn the sandbox helper (CreateProcessAsUserW failed: 5) and every shell command fails while the turn still completes.'
    );
  } else if (sandbox === "off") {
    warnings.push(
      'CODEX_DELEGATE_WINDOWS_SANDBOX="off" degrades workspace-write to read-only: agent-mode writes are denied and the turn still completes.'
    );
  }
  return { platform: "win32", windowsSandbox: sandbox, modes: [...WINDOWS_SANDBOX_MODES] };
}

async function probeLogin(command, execFileImpl = execFileAsync) {
  if (!command) return { status: "skipped", reason: "codex_not_found" };
  try {
    const { stdout, stderr } = await execFileImpl(command, ["login", "status"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: false,
    });
    const text = `${stdout || ""}${stderr || ""}`.trim();
    return {
      status: "ok",
      exitCode: 0,
      detail: text.slice(0, 400) || null,
    };
  } catch (err) {
    const text = `${err.stdout || ""}${err.stderr || ""}`.trim();
    return {
      status: "failed",
      exitCode: typeof err?.code === "number" ? err.code : null,
      detail: text.slice(0, 400) || err?.message || null,
    };
  }
}

/** Lightweight deep check: help surfaces exist. No model quota. */
async function runDeepSmoke({ codex, execFileImpl = execFileAsync }) {
  if (!codex.found) {
    return { ran: false, reason: "codex_not_found" };
  }
  const surfaces = ["exec", "exec review", "exec resume"];
  const results = {};
  for (const surface of surfaces) {
    const args = surface.split(" ").concat(["--help"]);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      ({ stdout, stderr } = await execFileImpl(codex.command, args, {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
        shell: false,
      }));
    } catch (err) {
      stdout = err.stdout || "";
      stderr = err.stderr || "";
      exitCode = typeof err?.code === "number" ? err.code : null;
    }
    results[surface] = {
      ok: exitCode === 0,
      exitCode,
      hasJson: /--json/.test(`${stdout}${stderr}`),
      hasOutputLastMessage: /--output-last-message/.test(
        `${stdout}${stderr}`
      ),
    };
  }
  return { ran: true, surfaces: results, note: "Help-only smoke; no model calls." };
}

export { clearCodexCache };
