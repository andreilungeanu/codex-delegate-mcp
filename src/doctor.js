import process from "node:process";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { refreshCodex, clearCodexCache } from "./resolve-codex.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "./command.js";
import { readModelCatalog, modelEfforts } from "./model-catalog.js";
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
    // Resolution notes describe the resolver working. On Windows the loudest fires
    // on every correct machine, so they live on `codex.notes`, not `warnings`.
    if (resolved.warnings?.length) codex.notes = [...resolved.warnings];
  } catch (err) {
    codex = {
      found: false,
      error: err?.message || String(err),
      code: err?.code,
    };
    // A failed resolution is where the resolver's notes matter most: they name
    // what this machine actually tried and why each path was refused.
    if (Array.isArray(err?.details?.warnings) && err.details.warnings.length) {
      codex.notes = [...err.details.warnings];
    }
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
 * Inspects the workspace path and, for a directory, whether git sees a repo
 * (review needs one). A typo used to echo back as healthy.
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
      // SIGKILL: SIGTERM is catchable and would outlive the timeout.
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
 * in turn why delegate.js spawns the child in the requested workspace. Either shape
 * changing upstream changes what this bridge has to do, so it is worth being told
 * rather than discovering it from a run that used the wrong tree.
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
          ? `\`codex ${surface}\` now accepts --cd. This bridge assumes it does not: resume and review take their working directory only from the spawn. Recheck the argument builders against the new surface.`
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
 * `codex debug models` prints the catalog without spending quota. The model and
 * reasoningEffort fields are described from it at startup, so the only names left to check
 * against it are the two defaults this bridge pins itself.
 */
async function probeModelCatalog({ codex, execFileImpl = execFileAsync, warnings = [] }) {
  // Diagnostics can wait longer than a delegation: this is the only place the catalog is
  // read for its own sake, so a slow CLI is worth reporting rather than skipping.
  const all = await readModelCatalog({ command: codex.command, execFileImpl, timeoutMs: 8000 });
  if (!all) return { ran: false, reason: "unreadable" };
  const models = all
    .filter((model) => model?.visibility === "list")
    .map((model) => ({
      slug: model.slug,
      reasoningEfforts: modelEfforts([model], model.slug) || [],
      // Only while a retirement is scheduled: a field present on every entry stops
      // being read.
      ...(model.upgrade?.retirement_at ? { retiresAt: model.upgrade.retirement_at } : {}),
    }));

  // No check on the other models: the model field is described from this same catalog
  // when the server starts, so a model it adds or drops is not drift. The default is the
  // one model this bridge names itself.
  const defaultEntry = all.find((model) => model?.slug === DEFAULT_MODEL);
  const inCatalog = Boolean(defaultEntry);
  if (!inCatalog) {
    warnings.push(
      `The default model ${DEFAULT_MODEL} is not in the catalog this CLI prints. Every delegation that does not name its own model asks for it, so all of them would fail at the API. DEFAULT_MODEL in src/command.js is where it goes.`
    );
  }

  // The catalog dates a retirement before it lands, in `upgrade.retirement_at`, with the
  // replacement it names. Said while the default can still change, rather than once the
  // entry is gone and every delegation that names no model is already failing.
  const retiresAt = defaultEntry?.upgrade?.retirement_at;
  if (retiresAt) {
    const replacement = defaultEntry.upgrade.model
      ? `; the catalog names ${defaultEntry.upgrade.model} as its replacement`
      : "";
    warnings.push(
      `The default model ${DEFAULT_MODEL} retires on ${retiresAt}${replacement}. DEFAULT_MODEL in src/command.js is where it changes.`
    );
  }

  // The default effort rides on every delegation that names no level, whatever model it
  // names. The default model is the one it is checked against: a catalog that stops listing
  // it there is about to turn every plain delegation into a warning. An entry with no list
  // says nothing either way.
  const defaultEfforts = modelEfforts(all, DEFAULT_MODEL);
  if (defaultEfforts && !defaultEfforts.includes(DEFAULT_REASONING_EFFORT)) {
    warnings.push(
      `The default reasoning level ${DEFAULT_REASONING_EFFORT} is not among the levels the catalog lists for ${DEFAULT_MODEL} (${defaultEfforts.join(", ")}). A delegation that uses both defaults is forwarded with a warning, and Codex may normalize or reject it. DEFAULT_REASONING_EFFORT in src/command.js is where it changes.`
    );
  }

  return { ran: true, models, defaultModel: { slug: DEFAULT_MODEL, inCatalog } };
}

export { clearCodexCache };
