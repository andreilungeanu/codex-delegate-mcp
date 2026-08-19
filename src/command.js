import process from "node:process";
import path from "node:path";
import { statSync } from "node:fs";

/** @type {readonly [string, ...string[]]} */
export const MODES = Object.freeze(["agent", "plan", "ask", "review"]);

/** Default worker model — orchestrator overrides only when the user asks. */
export const DEFAULT_MODEL = "gpt-5.6-terra";

/** Default reasoning effort — quality over speed unless the user asks otherwise. */
export const DEFAULT_REASONING_EFFORT = "high";

/**
 * Leave headroom under the Windows CreateProcess ~32k limit. Review only: every
 * other mode sends the brief on stdin, so nothing large is left in its argv.
 */
export const MAX_REVIEW_ARGV_CHARS = 28_000;

/**
 * Codex reads the prompt from stdin when the positional is `-`. The brief goes that
 * way so it never lands in a command line, which any local process can read
 * (`/proc/*​/cmdline`, or WMI on Windows) — and briefs are told to quote the user's
 * exact values. It also lifts the argv length limit off the brief, since only the
 * flags are left in argv. Review mode cannot use it; see buildReviewArgs.
 */
const STDIN_PROMPT = "-";

/**
 * Which values a model accepts is not discoverable up front and differs by model:
 * gpt-5.6-* take none|low|medium|high|xhigh|max and reject minimal, which older
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
  "max",
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
 * }} [options]
 */
export function buildCodexArgs(request, { resultFile, outputSchemaFile } = {}) {
  if (!request || typeof request !== "object") throw new TypeError("request required");
  if (!resultFile || typeof resultFile !== "string") throw new TypeError("resultFile required");
  if (!MODES.includes(request.mode)) throw new Error(`unsupported mode: ${request.mode}`);

  let built;
  if (request.mode === "review") {
    if (outputSchemaFile) throw new Error("output schema is not supported in review mode");
    built = buildReviewArgs(request, { resultFile });
  } else if (request.mode === "ask" && outputSchemaFile) {
    throw new Error("output schema is not supported in ask mode");
  } else if (request.mode === "plan" && !outputSchemaFile) {
    throw new Error("plan mode requires outputSchemaFile");
  } else if (request.resumeThreadId) {
    built = buildResumeArgs(request, { resultFile, outputSchemaFile });
  } else {
    built = buildInitialArgs(request, { resultFile, outputSchemaFile });
  }
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

function assertReviewArgvLength(args) {
  const chars = estimateArgvChars(args);
  if (chars <= MAX_REVIEW_ARGV_CHARS) return;
  const err = /** @type {Error & { code?: string }} */ (
    new Error(
      `Codex argv is too long (${chars} chars; limit ${MAX_REVIEW_ARGV_CHARS}). Shorten the spec brief: review cannot send it on stdin.`
    )
  );
  err.code = "argv_too_long";
  throw err;
}

function buildInitialArgs(request, { resultFile, outputSchemaFile }) {
  const args = [
    "exec",
    ...commonFlags(request, resultFile, outputSchemaFile),
    "--cd",
    request.workspace,
    "--skip-git-repo-check",
    "--",
    STDIN_PROMPT,
  ];
  return { kind: "initial", args, stdin: request.spec };
}

function buildResumeArgs(request, { resultFile, outputSchemaFile }) {
  // `codex exec resume` has no --cd: the turn runs wherever the child is spawned,
  // which is why delegate.js spawns it in request.workspace and why the workspace
  // has to be the one the thread started in, not whatever this server sits on.
  const args = [
    "exec",
    "resume",
    ...commonFlags(request, resultFile, outputSchemaFile),
    "--skip-git-repo-check",
    request.resumeThreadId,
    "--",
    STDIN_PROMPT,
  ];
  return { kind: "resume", args, stdin: request.spec };
}

function buildReviewArgs(request, { resultFile }) {
  if (!request.reviewTarget) throw new Error("reviewTarget required in review mode");
  const args = [
    "exec",
    "review",
    ...commonFlags(request, resultFile, null),
    "-c",
    `developer_instructions=${tomlString(request.spec)}`,
    "--skip-git-repo-check",
    ...reviewTargetArgs(request.reviewTarget),
  ];
  // No stdin: `exec review` rejects a positional prompt alongside a target, so the
  // brief has to keep travelling in argv here — command line and cap included.
  assertReviewArgvLength(args);
  return { kind: "review", args, stdin: null };
}

function commonFlags(request, resultFile, outputSchemaFile) {
  // On unless the caller opts out. Drives Codex's `web_search` and nothing else.
  const webSearch = request.webSearch !== false;
  const args = [
    "--json",
    "--output-last-message",
    resultFile,
    // Every flag here then means what it says. Without it the user's own
    // ~/.codex config is merged in and can change model, effort or anything else
    // under a run the caller believes it fully specified.
    "--ignore-user-config",
    // Every `-c` key below is a contract with Codex, and without this an unrecognized
    // one is accepted in silence: measured on 0.147.0, `-c features.bogus=false` runs
    // the turn without complaint. Flags do not need the help — an unknown flag is a
    // clap error, and `--disable` refuses an unknown feature on its own. This closes
    // the `-c` half, at config-parse time, before the turn starts. Nothing here reads
    // a config.toml; `--ignore-user-config` already loads none.
    "--strict-config",
    "--disable",
    "hooks",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `web_search=${tomlString(webSearch ? "live" : "disabled")}`,
  ];

  // Codex Fast mode (/fast): leave unset by default; enable only when request.fast === true.
  if (request.fast === true) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }

  if (outputSchemaFile) args.push("--output-schema", outputSchemaFile);
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

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function validateDelegateInput(raw, { cwd = process.cwd() } = {}) {
  if (!raw || typeof raw !== "object") throw bad("invalid_input", "delegate args must be an object");
  const spec = String(raw.spec ?? "").trim();
  if (!spec) throw bad("invalid_spec", "spec is required");

  const mode = raw.mode ?? "agent";
  if (!MODES.includes(mode)) throw bad("invalid_mode", `mode must be one of ${MODES.join(", ")}`);

  // Defaulting this meant the server's own directory, which under npx or a plugin is
  // a cache folder or the user's home: the run completed, reported clean, and edited
  // a tree nobody asked about. Resume already refused a defaulted workspace for that
  // reason, and there was never one for the first turn to differ.
  if (!raw.workspace || !String(raw.workspace).trim()) {
    throw bad(
      "invalid_workspace",
      "workspace is required: name the directory Codex should work in"
    );
  }
  // A workspace that does not exist used to reach Codex and be created by its first
  // write, so a typo produced a parallel empty tree that looked like success throughout.
  const workspace = path.resolve(cwd, String(raw.workspace).trim());
  let workspaceStat;
  try {
    workspaceStat = statSync(workspace);
  } catch {
    throw bad("invalid_workspace", `workspace does not exist: ${workspace}`);
  }
  if (!workspaceStat.isDirectory()) {
    throw bad("invalid_workspace", `workspace is not a directory: ${workspace}`);
  }

  // Live web search is on unless the caller opts out.
  const webSearch = raw.webSearch !== false;

  let resumeThreadId;
  if (raw.resumeThreadId != null && String(raw.resumeThreadId).trim()) {
    resumeThreadId = String(raw.resumeThreadId).trim();
    if (mode === "review") throw bad("invalid_resume", "resumeThreadId is not allowed with review");
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
    webSearch,
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
