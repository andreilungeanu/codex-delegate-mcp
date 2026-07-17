import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolveCodex, MIN_VERSION, clearCodexCache } from "./resolve-codex.js";
import { VERSION } from "./version.js";

export async function runDoctor({
  deep = false,
  workspace = process.cwd(),
  resolve = resolveCodex,
  env = process.env,
  getClientInfo,
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
    warnings.push(...(resolved.warnings || []));
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

  const login = probeLogin(codex.found ? codex.command : null);
  const recursion = {
    depth: env.CODEX_DELEGATE_DEPTH ?? null,
    active: Boolean(env.CODEX_DELEGATE_DEPTH && String(env.CODEX_DELEGATE_DEPTH).trim()),
  };

  const out = {
    plugin: { version: VERSION, name: "codex-delegate-mcp" },
    client,
    codex,
    versionGate: { minimum: MIN_VERSION, status: codex.found ? "ok" : "unresolved" },
    login,
    recursionGuard: recursion,
    workspace: { path: workspace },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      transport: "stdio",
    },
    warnings,
  };

  if (deep) {
    out.deep = await runDeepSmoke({ codex, workspace, env });
  }

  return out;
}

function probeLogin(command) {
  if (!command) return { status: "skipped", reason: "codex_not_found" };
  try {
    const result = spawnSync(command, ["login", "status"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: false,
    });
    const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
    return {
      status: result.status === 0 ? "ok" : "failed",
      exitCode: result.status,
      detail: text.slice(0, 400) || null,
    };
  } catch (err) {
    return { status: "error", detail: err?.message || String(err) };
  }
}

/** Lightweight deep check: help surfaces exist. No model quota. */
async function runDeepSmoke({ codex }) {
  if (!codex.found) {
    return { ran: false, reason: "codex_not_found" };
  }
  const surfaces = ["exec", "exec review", "exec resume"];
  const results = {};
  for (const surface of surfaces) {
    const args = surface.split(" ").concat(["--help"]);
    const result = spawnSync(codex.command, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: false,
    });
    results[surface] = {
      ok: result.status === 0,
      exitCode: result.status,
      hasJson: /--json/.test(`${result.stdout}${result.stderr}`),
      hasOutputLastMessage: /--output-last-message/.test(
        `${result.stdout}${result.stderr}`
      ),
    };
  }
  return { ran: true, surfaces: results, note: "Help-only smoke; no model calls." };
}

export { clearCodexCache };
