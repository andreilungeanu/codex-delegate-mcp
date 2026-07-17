import process from "node:process";
import path from "node:path";

export const MODES = Object.freeze(["agent", "plan", "ask", "review"]);

/** Default worker model — orchestrator overrides only when the user asks. */
export const DEFAULT_MODEL = "gpt-5.6-terra";

/** Default reasoning effort — quality over speed unless the user asks otherwise. */
export const DEFAULT_REASONING_EFFORT = "high";

/** Leave headroom under Windows CreateProcess ~32k limit. */
export const MAX_ARGV_CHARS = 28_000;

export const REASONING_EFFORTS = Object.freeze([
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
export function buildCodexArgs(request, { resultFile, outputSchemaFile, platform = process.platform } = {}) {
  if (!request || typeof request !== "object") throw new TypeError("request required");
  if (!resultFile || typeof resultFile !== "string") throw new TypeError("resultFile required");
  if (!MODES.includes(request.mode)) throw new Error(`unsupported mode: ${request.mode}`);

  let built;
  if (request.mode === "review") {
    if (outputSchemaFile) throw new Error("output schema is not supported in review mode");
    built = buildReviewArgs(request, { resultFile, platform });
  } else if (request.mode === "ask" && outputSchemaFile) {
    throw new Error("output schema is not supported in ask mode");
  } else if (request.mode === "plan" && !outputSchemaFile) {
    throw new Error("plan mode requires outputSchemaFile");
  } else if (request.resumeThreadId) {
    built = buildResumeArgs(request, { resultFile, outputSchemaFile, platform });
  } else {
    built = buildInitialArgs(request, { resultFile, outputSchemaFile, platform });
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
    const err = new Error(
      `Codex argv is too long (${chars} chars; limit ${MAX_ARGV_CHARS}). Shorten the spec brief.`
    );
    err.code = "argv_too_long";
    throw err;
  }
}

function buildInitialArgs(request, { resultFile, outputSchemaFile, platform }) {
  const sandbox = sandboxForMode(request.mode);
  const args = [
    "exec",
    ...commonFlags(request, resultFile, outputSchemaFile, platform),
    "--sandbox",
    sandbox,
    "--cd",
    request.workspace,
    "--skip-git-repo-check",
    "--",
    request.spec,
  ];
  return { kind: "initial", args, sandbox };
}

function buildResumeArgs(request, { resultFile, outputSchemaFile, platform }) {
  const sandbox = sandboxForMode(request.mode);
  const args = [
    "exec",
    "resume",
    ...commonFlags(request, resultFile, outputSchemaFile, platform),
    "-c",
    `sandbox_mode=${tomlString(sandbox)}`,
    "--skip-git-repo-check",
    request.resumeThreadId,
    "--",
    request.spec,
  ];
  return { kind: "resume", args, sandbox };
}

function buildReviewArgs(request, { resultFile, platform }) {
  if (!request.reviewTarget) throw new Error("reviewTarget required in review mode");
  const args = [
    "exec",
    "review",
    ...commonFlags(request, resultFile, null, platform),
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    `developer_instructions=${tomlString(request.spec)}`,
    "--skip-git-repo-check",
    ...reviewTargetArgs(request.reviewTarget),
  ];
  return { kind: "review", args, sandbox: "read-only" };
}

function commonFlags(request, resultFile, outputSchemaFile, platform) {
  const network = request.mode === "agent" && request.network === true;
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
  if (platform === "win32") args.push("-c", 'windows.sandbox="elevated"');
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

export function validateDelegateInput(raw, { cwd = process.cwd() } = {}) {
  if (!raw || typeof raw !== "object") throw bad("invalid_input", "delegate args must be an object");
  const spec = String(raw.spec ?? "").trim();
  if (!spec) throw bad("invalid_spec", "spec is required");

  const mode = raw.mode ?? "agent";
  if (!MODES.includes(mode)) throw bad("invalid_mode", `mode must be one of ${MODES.join(", ")}`);

  const workspace = path.resolve(cwd, raw.workspace || cwd);
  const network = raw.network === true;
  if (network && mode !== "agent") {
    throw bad("invalid_network", "network:true is only allowed in agent mode");
  }

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
  const err = new Error(message);
  err.code = code;
  return err;
}
