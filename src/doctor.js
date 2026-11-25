import process from "node:process";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { resolveCodex } from "./resolve-codex.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "./command.js";
import { readModelCatalog, modelEfforts } from "./model-catalog.js";
import { readRateLimits, describeUsage } from "./account.js";
import { isGitRepo } from "./git-preflight.js";
import { VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

/** Reported when set: each changes how a delegation runs. CODEX_DELEGATE_DEPTH is recursionGuard. */
const ENV_KNOBS = ["CODEX_DELEGATE_COMMAND", "CODEX_DELEGATE_STARTUP_MS", "CODEX_DELEGATE_HARD_CAP_MS"];

const PROBE_TIMEOUT_MS = 8000;

/**
 * @param {{
 *   deep?: boolean,
 *   workspace?: string,
 *   resolve?: any,
 *   env?: NodeJS.ProcessEnv,
 *   getClientInfo?: any,
 *   execFileImpl?: any,
 *   readUsage?: typeof readRateLimits,
 * }} [options]
 */
export async function runDoctor({
  deep = false,
  workspace = process.cwd(),
  resolve = resolveCodex,
  env = process.env,
  getClientInfo,
  execFileImpl = execFileAsync,
  readUsage = readRateLimits,
} = {}) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {any} */
  let agent = { found: false };
  try {
    const resolved = resolve({ env });
    agent = {
      found: true,
      command: resolved.command,
      ...(resolved.commandArgs?.length ? { commandArgs: [...resolved.commandArgs] } : {}),
      source: resolved.source,
      ...(resolved.shim ? { shim: resolved.shim } : {}),
      version: resolved.version,
    };
    // Resolver notes are left out once it resolved: on Windows the loudest fires on every correct machine.
  } catch (err) {
    agent = { found: false, error: err?.message || String(err), code: err?.code };
    // On a failed resolution the notes name what this machine tried and why each path was refused.
    if (Array.isArray(err?.details?.warnings) && err.details.warnings.length) {
      agent.notes = [...err.details.warnings];
    }
    warnings.push(`Codex CLI not found: ${agent.error}`);
  }

  const auth = await probeLogin(agent, execFileImpl);
  if (auth.status === "logged-out") warnings.push("Codex is not logged in. Run `codex login`.");

  /** @type {Record<string, any>} */
  const out = {
    plugin: { name: "codex-delegate-mcp", version: VERSION },
    client: describeClient(getClientInfo),
    agent,
    auth,
    workspace: await describeWorkspace(workspace, warnings, execFileImpl),
  };

  const depth = env.CODEX_DELEGATE_DEPTH;
  if (depth && String(depth).trim()) out.recursionGuard = { depth };
  const set = ENV_KNOBS.filter((name) => env[name] !== undefined);
  if (set.length) out.env = Object.fromEntries(set.map((name) => [name, env[name]]));
  out.warnings = warnings;

  if (deep && agent.found) {
    const [, models, rawUsage] = await Promise.all([
      checkHelpSurfaces(agent, execFileImpl, warnings),
      probeModelCatalog(agent, execFileImpl, warnings),
      readUsage({ command: agent.command, commandArgs: agent.commandArgs }),
    ]);
    out.models = models;
    const usage = describeUsage(rawUsage, warnings);
    if (usage) {
      const { plan, ...rest } = usage;
      if (plan) auth.plan = plan;
      out.usage = rest;
    } else {
      out.usage = { ran: false, reason: "unreadable" };
    }
  }

  return out;
}

function describeClient(getClientInfo) {
  try {
    const info = getClientInfo?.() || {};
    return {
      name: info.version?.name ?? null,
      version: info.version?.version ?? null,
      // The MCP revision the host speaks: 2026-07-28 or a 2025-era one.
      ...(typeof info.protocolVersion === "string" ? { protocolVersion: info.protocolVersion } : {}),
    };
  } catch {
    return { name: null, version: null };
  }
}

/** The workspace path and, for a directory, whether git sees a repo (review needs one). */
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
    // Asked of git, not a .git lookup: the skill passes the smallest fitting directory, usually a
    // subdirectory, and the answer has to match the review preflight's.
    const repo = await isGitRepo(workspace, execFileImpl);
    if (repo !== null) out.isGitRepo = repo;
  }
  return out;
}

function runCodex(agent, args, execFileImpl) {
  return execFileImpl(agent.command, [...(agent.commandArgs ?? []), ...args], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    // SIGKILL: SIGTERM is catchable and would outlive the timeout.
    killSignal: "SIGKILL",
    windowsHide: true,
    shell: false,
  });
}

/** `codex login status` exits 0 when logged in and non-zero when not. */
async function probeLogin(agent, execFileImpl) {
  if (!agent.found) return { status: "unknown" };
  try {
    const { stdout, stderr } = await runCodex(agent, ["login", "status"], execFileImpl);
    const text = `${stdout || ""}${stderr || ""}`.trim();
    const method = /chatgpt/i.test(text) ? "chatgpt" : /api key/i.test(text) ? "api-key" : null;
    return method ? { status: "ok", method } : { status: "ok", detail: text.slice(0, 400) || null };
  } catch (err) {
    const text = `${err.stdout || ""}${err.stderr || ""}`.trim();
    return {
      // A number is the CLI's own exit; anything else (timeout, spawn failure) says nothing about login.
      status: typeof err?.code === "number" ? "logged-out" : "unknown",
      detail: text.slice(0, 400) || err?.message || null,
    };
  }
}

/** The help of each exec surface delegation runs, checked for the flags it passes. Warns only. */
async function checkHelpSurfaces(agent, execFileImpl, warnings) {
  for (const surface of ["exec", "exec review", "exec resume"]) {
    let help = "";
    try {
      const { stdout, stderr } = await runCodex(agent, [...surface.split(" "), "--help"], execFileImpl);
      help = `${stdout || ""}${stderr || ""}`;
    } catch (err) {
      const why = typeof err?.code === "number" ? `exit ${err.code}` : err?.message;
      warnings.push(`\`codex ${surface} --help\` failed (${why}); delegation runs through it.`);
      continue;
    }
    for (const flag of ["--json", "--output-last-message"]) {
      if (!help.includes(flag)) warnings.push(`\`codex ${surface} --help\` does not list ${flag}, which delegation passes.`);
    }
  }
}

/**
 * `codex debug models` prints the catalog without spending quota. The model and
 * reasoningEffort fields are described from it at startup, so the only names left to check
 * against it are the two defaults this bridge pins itself.
 */
async function probeModelCatalog(agent, execFileImpl, warnings) {
  const all = await readModelCatalog({ command: agent.command, commandArgs: agent.commandArgs, execFileImpl, timeoutMs: PROBE_TIMEOUT_MS });
  if (!all) return { ran: false, reason: "unreadable" };
  const listed = all.filter((model) => model?.visibility === "list");
  const available = listed.map((model) => model.slug);
  const effortsOf = new Map(listed.map((model) => [model.slug, modelEfforts([model], model.slug) || []]));
  // The most common level list is stated once; only models that differ from it are named.
  const counts = new Map();
  for (const levels of effortsOf.values()) counts.set(levels.join(","), (counts.get(levels.join(",")) || 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const efforts = common ? common.split(",") : [];
  const effortsByModel = Object.fromEntries([...effortsOf].filter(([, levels]) => levels.join(",") !== common));
  const retiring = Object.fromEntries(
    listed.filter((model) => model.upgrade?.retirement_at).map((model) => [model.slug, model.upgrade.retirement_at])
  );

  const defaultEntry = all.find((model) => model?.slug === DEFAULT_MODEL);
  if (!defaultEntry) {
    warnings.push(
      `The default model ${DEFAULT_MODEL} is not in the catalog this CLI prints. Every delegation that does not name its own model asks for it, so all of them would fail at the API. DEFAULT_MODEL in src/command.js is where it goes.`
    );
  }

  // Said while the default can still change, not once every delegation naming no model fails.
  const retiresAt = defaultEntry?.upgrade?.retirement_at;
  if (retiresAt) {
    const replacement = defaultEntry.upgrade.model
      ? `; the catalog names ${defaultEntry.upgrade.model} as its replacement`
      : "";
    warnings.push(
      `The default model ${DEFAULT_MODEL} retires on ${retiresAt}${replacement}. DEFAULT_MODEL in src/command.js is where it changes.`
    );
  }

  // The default effort rides on every delegation that names no level. An entry with no list says
  // nothing either way.
  const defaultEfforts = modelEfforts(all, DEFAULT_MODEL);
  if (defaultEfforts && !defaultEfforts.includes(DEFAULT_REASONING_EFFORT)) {
    warnings.push(
      `The default reasoning level ${DEFAULT_REASONING_EFFORT} is not among the levels the catalog lists for ${DEFAULT_MODEL} (${defaultEfforts.join(", ")}). A delegation that uses both defaults is forwarded with a warning, and Codex may normalize or reject it. DEFAULT_REASONING_EFFORT in src/command.js is where it changes.`
    );
  }

  return {
    default: DEFAULT_MODEL,
    defaultAvailable: Boolean(defaultEntry),
    available,
    efforts,
    ...(Object.keys(effortsByModel).length ? { effortsByModel } : {}),
    ...(Object.keys(retiring).length ? { retiring } : {}),
  };
}
