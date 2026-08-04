import process from "node:process";
import path from "node:path";
import { statSync } from "node:fs";

/** @type {readonly [string, ...string[]]} */
export const MODES = Object.freeze(["agent", "plan", "ask", "review"]);

/** Default worker model — orchestrator overrides only when the user asks. */
export const DEFAULT_MODEL = "gpt-5.6-terra";

/** Default reasoning effort — quality over speed unless the user asks otherwise. */
export const DEFAULT_REASONING_EFFORT = "high";

/** Leave headroom under Windows CreateProcess ~32k limit. */
export const MAX_ARGV_CHARS = 28_000;

/**
 * Codex reads the prompt from stdin when the positional is `-`. The brief goes that
 * way so it never lands in a command line, which any local process can read
 * (`/proc/*​/cmdline`, or WMI on Windows) — and briefs are told to quote the user's
 * exact values. It also lifts MAX_ARGV_CHARS off the brief, since only the flags are
 * left in argv. Review mode cannot use it; see buildReviewArgs.
 */
const STDIN_PROMPT = "-";

/**
 * Windows only, and not optional: --ignore-user-config strips the user's own
 * [windows] setting, and Codex without one degrades workspace-write to read-only,
 * so agent mode cannot write at all. The default was `elevated`, which needs an
 * elevated session — on a normal one Codex cannot spawn the sandbox helper
 * (CreateProcessAsUserW failed: 5), so every shell command in every mode fails
 * while the turn still reports as completed.
 */
export const DEFAULT_WINDOWS_SANDBOX = "unelevated";
/** What Codex accepts today. Not a whitelist — an unknown value is passed through. */
export const WINDOWS_SANDBOX_MODES = Object.freeze(["unelevated", "elevated"]);

/**
 * Which values a model accepts is not discoverable up front and differs by model:
 * gpt-5.6-* take none|low|medium|high|xhigh and reject minimal, which older
 * models take. A rejected value comes back as the model's own error.
 */
/** @type {readonly [string, ...string[]]} */
export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const PLAN_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["overview", "steps"],
  properties: {
    overview: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
});

/**
 * Build argv for one `codex exec` invocation.
 * Codex binary is resolved separately; this only returns args after the executable.
 */
/**
 * @param {any} request
 * @param {{
 *   resultFile?: string,
 *   outputSchemaFile?: string | null,
 *   platform?: string,
 *   windowsSandbox?: string,
 * }} [options]
 */
export function buildCodexArgs(
  request,
  {
    resultFile,
    outputSchemaFile,
    platform = process.platform,
    windowsSandbox = DEFAULT_WINDOWS_SANDBOX,
  } = {}
) {
  if (!request || typeof request !== "object") throw new TypeError("request required");
  if (!resultFile || typeof resultFile !== "string") throw new TypeError("resultFile required");
  if (!MODES.includes(request.mode)) throw new Error(`unsupported mode: ${request.mode}`);

  let built;
  if (request.mode === "review") {
    if (outputSchemaFile) throw new Error("output schema is not supported in review mode");
    built = buildReviewArgs(request, { resultFile, platform, windowsSandbox });
  } else if (request.mode === "ask" && outputSchemaFile) {
    throw new Error("output schema is not supported in ask mode");
  } else if (request.mode === "plan" && !outputSchemaFile) {
    throw new Error("plan mode requires outputSchemaFile");
  } else if (request.resumeThreadId) {
    built = buildResumeArgs(request, { resultFile, outputSchemaFile, platform, windowsSandbox });
  } else {
    built = buildInitialArgs(request, { resultFile, outputSchemaFile, platform, windowsSandbox });
  }
  assertArgvLength(built.args);
  return built;
}

/** Approximate CreateProcess command-line length (quoted tokens + spaces). */
export function estimateArgvChars(args) {
  let total = 0;
  for (const raw of args) {
    const token = String(raw);
    const needsQuotes = /[\s"]/.test(token);
    const escaped = token.replace(/"/g, '\\"');
    total += needsQuotes ? escaped.length + 2 : escaped.length;
    total += 1; // separator
  }
  return total;
}

function assertArgvLength(args) {
  const chars = estimateArgvChars(args);
  if (chars > MAX_ARGV_CHARS) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(
        `Codex argv is too long (${chars} chars; limit ${MAX_ARGV_CHARS}). Shorten the spec brief.`
      )
    );
    err.code = "argv_too_long";
    throw err;
  }
}

function buildInitialArgs(request, { resultFile, outputSchemaFile, platform, windowsSandbox }) {
  const sandbox = sandboxForMode(request.mode);
  const args = [
    "exec",
    ...commonFlags(request, resultFile, outputSchemaFile, platform, windowsSandbox),
    "--sandbox",
    sandbox,
    "--cd",
    request.workspace,
    "--skip-git-repo-check",
    "--",
    STDIN_PROMPT,
  ];
  return { kind: "initial", args, sandbox, stdin: request.spec };
}

function buildResumeArgs(request, { resultFile, outputSchemaFile, platform, windowsSandbox }) {
  const sandbox = sandboxForMode(request.mode);
  const args = [
    "exec",
    "resume",
    ...commonFlags(request, resultFile, outputSchemaFile, platform, windowsSandbox),
    "-c",
    `sandbox_mode=${tomlString(sandbox)}`,
    "--skip-git-repo-check",
    request.resumeThreadId,
    "--",
    STDIN_PROMPT,
  ];
  return { kind: "resume", args, sandbox, stdin: request.spec };
}

function buildReviewArgs(request, { resultFile, platform, windowsSandbox }) {
  if (!request.reviewTarget) throw new Error("reviewTarget required in review mode");
  const args = [
    "exec",
    "review",
    ...commonFlags(request, resultFile, null, platform, windowsSandbox),
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    `developer_instructions=${tomlString(request.spec)}`,
    "--skip-git-repo-check",
    ...reviewTargetArgs(request.reviewTarget),
  ];
  // No stdin: `exec review` rejects a positional prompt alongside a target, so the
  // brief has to keep travelling in argv here — command line and cap included.
  return { kind: "review", args, sandbox: "read-only", stdin: null };
}

function commonFlags(request, resultFile, outputSchemaFile, platform, windowsSandbox) {
  // On unless the caller opts out. `network_access` only binds the workspace-write
  // sandbox, so in the read-only modes this is effectively the web_search switch.
  const network = request.network !== false;
  const args = [
    "--json",
    "--output-last-message",
    resultFile,
    "--ignore-user-config",
    "--disable",
    "hooks",
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_workspace_write.network_access=${network ? "true" : "false"}`,
    "-c",
    `web_search=${tomlString(network ? "live" : "disabled")}`,
  ];

  // Codex Fast mode (/fast): leave unset by default; enable only when request.fast === true.
  if (request.fast === true) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }

  if (outputSchemaFile) args.push("--output-schema", outputSchemaFile);
  // --ignore-user-config strips the user's [windows] sandbox setting, and without
  // one workspace-write degrades to read-only, so this always goes.
  if (platform === "win32") {
    args.push("-c", `windows.sandbox=${tomlString(windowsSandbox)}`);
  }
  if (request.model) args.push("--model", request.model);
  if (request.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${tomlString(request.reasoningEffort)}`);
  }
  return args;
}

function reviewTargetArgs(target) {
  switch (target.kind) {
    case "uncommitted":
      return ["--uncommitted"];
    case "base":
      return ["--base", target.branch];
    case "commit":
      return ["--commit", target.sha];
    default:
      throw new Error(`unsupported reviewTarget.kind: ${target.kind}`);
  }
}

function sandboxForMode(mode) {
  if (mode === "agent") return "workspace-write";
  return "read-only";
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * The point of this knob is to work around a Codex change we did not see coming,
 * so an unrecognized value travels rather than being replaced by one we like: a
 * list of modes we already knew about cannot rescue anyone from a new one. What
 * we do owe is a warning, since the same passthrough carries typos, and Codex
 * rejects an invalid mode at config load rather than at the write it affects.
 *
 * @param {unknown} raw
 * @param {{ platform?: string }} [options]
 */
export function resolveWindowsSandbox(raw, { platform = process.platform } = {}) {
  const warnings = [];
  const requested = raw == null ? "" : String(raw).trim();
  const sandbox = requested || DEFAULT_WINDOWS_SANDBOX;

  if (platform === "win32" && !WINDOWS_SANDBOX_MODES.includes(sandbox)) {
    warnings.push(
      `CODEX_DELEGATE_WINDOWS_SANDBOX="${sandbox}" is not one of ${WINDOWS_SANDBOX_MODES.join(
        ", "
      )}. It is passed to Codex as given; if Codex does not know it either, the run fails at config load.`
    );
  }

  return { sandbox, warnings };
}

export function validateDelegateInput(raw, { cwd = process.cwd() } = {}) {
  if (!raw || typeof raw !== "object") throw bad("invalid_input", "delegate args must be an object");
  const spec = String(raw.spec ?? "").trim();
  if (!spec) throw bad("invalid_spec", "spec is required");

  const mode = raw.mode ?? "agent";
  if (!MODES.includes(mode)) throw bad("invalid_mode", `mode must be one of ${MODES.join(", ")}`);

  // A missing workspace used to reach Codex and be created by its first write,
  // so a typo produced a parallel empty tree that looked like success throughout.
  const workspace = path.resolve(cwd, raw.workspace || cwd);
  let workspaceStat;
  try {
    workspaceStat = statSync(workspace);
  } catch {
    throw bad("invalid_workspace", `workspace does not exist: ${workspace}`);
  }
  if (!workspaceStat.isDirectory()) {
    throw bad("invalid_workspace", `workspace is not a directory: ${workspace}`);
  }

  // Codex runs connected by default: it can search the web, and in agent mode its
  // shell reaches the network so installs and fetches work. Pass network:false to
  // cut both off for a run that should stay sealed.
  const network = raw.network !== false;

  let resumeThreadId;
  if (raw.resumeThreadId != null && String(raw.resumeThreadId).trim()) {
    resumeThreadId = String(raw.resumeThreadId).trim();
    if (mode === "review") throw bad("invalid_resume", "resumeThreadId is not allowed with review");
    // `codex exec resume` has no --cd: the turn runs wherever the child is
    // spawned. Defaulting would silently run a thread against this server's own
    // directory, with the original workspace's context still loaded.
    if (raw.workspace == null) {
      throw bad(
        "invalid_workspace",
        "workspace is required when resuming: resume has no --cd, so an omitted workspace would run the thread in the server's directory rather than the one it started in"
      );
    }
  }

  let reviewTarget;
  if (mode === "review") {
    reviewTarget = normalizeReviewTarget(raw.reviewTarget);
  } else if (raw.reviewTarget != null) {
    throw bad("invalid_review_target", "reviewTarget is only valid in review mode");
  }

  let timeoutMs = raw.timeoutMs;
  if (timeoutMs != null) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86_400_000) {
      throw bad("invalid_timeout", "timeoutMs must be an integer from 1000 to 86400000");
    }
  }

  let model;
  if (raw.model == null) {
    model = DEFAULT_MODEL;
  } else {
    const trimmed = String(raw.model).trim();
    if (!trimmed) throw bad("invalid_model", "model must be a non-empty string when provided");
    model = trimmed;
  }

  let reasoningEffort =
    normalizeOptionalText(raw.reasoningEffort) ?? DEFAULT_REASONING_EFFORT;
  if (reasoningEffort && !REASONING_EFFORTS.includes(reasoningEffort)) {
    throw bad(
      "invalid_reasoning_effort",
      `reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}`
    );
  }

  const fast = raw.fast === true;

  return {
    spec,
    mode,
    workspace,
    resumeThreadId,
    model,
    reasoningEffort,
    fast,
    network,
    timeoutMs,
    reviewTarget,
  };
}

function normalizeOptionalText(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function normalizeReviewTarget(value) {
  if (!value || typeof value !== "object") {
    throw bad("invalid_review_target", "review mode requires reviewTarget");
  }
  if (value.kind === "uncommitted") return { kind: "uncommitted" };
  if (value.kind === "base") {
    const branch = String(value.branch || "").trim();
    if (!branch) throw bad("invalid_review_target", "reviewTarget.branch required");
    return { kind: "base", branch };
  }
  if (value.kind === "commit") {
    const sha = String(value.sha || "").trim();
    if (!sha) throw bad("invalid_review_target", "reviewTarget.sha required");
    return { kind: "commit", sha };
  }
  throw bad("invalid_review_target", "reviewTarget.kind must be uncommitted|base|commit");
}

function bad(code, message) {
  const err = /** @type {Error & { code?: string }} */ (new Error(message));
  err.code = code;
  return err;
}
