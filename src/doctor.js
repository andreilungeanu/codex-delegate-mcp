import process from "node:process";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { refreshCodex, clearCodexCache } from "./resolve-codex.js";
import { REASONING_EFFORTS, DEFAULT_MODEL } from "./command.js";
import { isGitRepo } from "./git-preflight.js";
import { VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

/**
 * @param {{
 *   deep?: boolean,
 *   workspace?: string,
 *   resolve?: any,
 *   env?: NodeJS.ProcessEnv,
 *   getClientInfo?: any,
 *   execFileImpl?: any,
 *   platform?: string,
 * }} [options]
 */
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

  const out = {
    plugin: { version: VERSION, name: "codex-delegate-mcp" },
    client,
    codex,
    login,
    recursionGuard: recursion,
    workspace: await describeWorkspace(workspace, warnings, execFileImpl),
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
    out.deep = await runDeepSmoke({ codex, execFileImpl, warnings });
  }

  return out;
}

/**
 * The workspace argument used to be echoed back and otherwise ignored, so a typo
 * looked healthy here and failed on the next delegate call. `review` additionally
 * needs a repository, which is worth saying before a review is attempted.
 */
async function describeWorkspace(workspace, warnings, execFileImpl) {
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
    // Asking git rather than looking for a .git entry: the answer has to match the
    // review preflight's, and the workspace the skill tells callers to pass is the
    // smallest directory that fits the task — usually a subdirectory, where a
    // .git lookup says "not a repository" about a perfectly reviewable path.
    const repo = await isGitRepo(workspace, execFileImpl);
    if (repo !== null) out.isGitRepo = repo;
  }
  return out;
}

async function probeLogin(command, execFileImpl = execFileAsync) {
  if (!command) return { status: "skipped", reason: "codex_not_found" };
  try {
    const { stdout, stderr } = await execFileImpl(command, ["login", "status"], {
      encoding: "utf8",
      timeout: 8000,
      // A timeout that sends the default SIGTERM bounds nothing against a child that
      // catches it: the probe then hangs past its own deadline, and doctor with it.
      killSignal: "SIGKILL",
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

/**
 * What this bridge assumes about `--cd` on each surface, and why the assumption is
 * load-bearing: an initial run passes the workspace as `--cd`, while resume and
 * review have no such flag, so their directory comes only from the spawn — which is
 * in turn why resume refuses a defaulted workspace. Either shape changing upstream
 * changes what this bridge has to do, so it is worth being told rather than
 * discovering it from a run that used the wrong tree.
 */
const CD_EXPECTED = Object.freeze({
  exec: true,
  "exec review": false,
  "exec resume": false,
});

/** The flag as clap prints it: `-C, --cd <DIR>`. */
const CD_FLAG = /--cd\b/;

/** Lightweight deep check: help surfaces and the model catalog. No model quota. */
async function runDeepSmoke({ codex, execFileImpl = execFileAsync, warnings = [] }) {
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
        killSignal: "SIGKILL",
        windowsHide: true,
        shell: false,
      }));
    } catch (err) {
      stdout = err.stdout || "";
      stderr = err.stderr || "";
      exitCode = typeof err?.code === "number" ? err.code : null;
    }
    const help = `${stdout}${stderr}`;
    const hasCd = CD_FLAG.test(help);
    results[surface] = {
      ok: exitCode === 0,
      exitCode,
      hasJson: /--json/.test(help),
      hasOutputLastMessage: /--output-last-message/.test(help),
      hasCd,
    };
    // Only on disagreement, and only when the probe itself worked: a help call that
    // failed reports no flags at all, and `ok: false` already says so.
    if (exitCode === 0 && hasCd !== CD_EXPECTED[surface]) {
      warnings.push(
        hasCd
          ? `\`codex ${surface}\` now accepts --cd. This bridge assumes it does not: resume and review take their working directory only from the spawn, which is why resume refuses a defaulted workspace. Recheck the argument builders against the new surface.`
          : `\`codex ${surface}\` no longer accepts --cd, which this bridge passes on every initial run. An unknown flag is a hard argument error, so every delegation would fail before it started. The child is spawned in the workspace either way, so dropping the flag is the fix.`
      );
    }
  }
  return {
    ran: true,
    surfaces: results,
    models: await probeModelCatalog({ codex, execFileImpl, warnings }),
    note: "Help and catalog only; no model calls.",
  };
}

/**
 * `codex debug models` prints the catalog without spending quota, so what this bridge
 * accepts can be checked against what the models take rather than assumed. The lag it
 * catches has shipped three times — xhigh, then max, then ultra — each unreachable
 * through this bridge until someone compared the two lists by hand.
 */
async function probeModelCatalog({ codex, execFileImpl = execFileAsync, warnings = [] }) {
  let stdout = "";
  try {
    ({ stdout } = await execFileImpl(codex.command, ["debug", "models"], {
      encoding: "utf8",
      timeout: 8000,
      killSignal: "SIGKILL",
      windowsHide: true,
      shell: false,
      // The catalog runs to ~280 KB and every model adds to it, so the 1 MB default
      // would eventually fail this probe rather than the drift it exists to report.
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (err) {
    // `debug` is a debugging surface and can move. A catalog this cannot read reports
    // nothing; the rest of doctor is unaffected.
    return { ran: false, reason: "probe_failed", exitCode: typeof err?.code === "number" ? err.code : null };
  }

  let catalog;
  try {
    catalog = JSON.parse(stdout);
  } catch {
    return { ran: false, reason: "unparseable" };
  }

  const all = Array.isArray(catalog?.models) ? catalog.models : [];
  const models = all
    .filter((model) => model?.visibility === "list")
    .map((model) => ({
      slug: model.slug,
      reasoningEfforts: (model.supported_reasoning_levels || []).map((level) => level?.effort),
    }));

  // One direction only. The reverse would fire on none and minimal, which the catalog
  // omits and the models still take — none on the gpt-5.6 models, minimal on the older
  // ones — so warning on them would train the reader to skip this field.
  const unreachable = [...new Set(models.flatMap((model) => model.reasoningEfforts))].filter(
    (effort) => effort && !REASONING_EFFORTS.includes(effort)
  );
  if (unreachable.length) {
    warnings.push(
      `The model catalog lists reasoning levels this bridge rejects (${unreachable.join(", ")}). reasoningEffort is validated against a fixed enum, so a level missing from it cannot be requested at all. REASONING_EFFORTS in src/command.js is where it goes.`
    );
  }

  const inCatalog = all.some((model) => model?.slug === DEFAULT_MODEL);
  if (!inCatalog) {
    warnings.push(
      `The default model ${DEFAULT_MODEL} is not in the catalog this CLI prints. Every delegation that does not name its own model asks for it, so all of them would fail at the API. DEFAULT_MODEL in src/command.js is where it goes.`
    );
  }

  return { ran: true, models, defaultModel: { slug: DEFAULT_MODEL, inCatalog } };
}

export { clearCodexCache };
