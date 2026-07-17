import process from "node:process";
import path from "node:path";

export const MODES = Object.freeze(["agent", "plan", "ask", "review"]);

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

  if (request.mode === "review") {
    if (outputSchemaFile) throw new Error("output schema is not supported in review mode");
    return buildReviewArgs(request, { resultFile, platform });
  }
  if (request.mode === "ask" && outputSchemaFile) {
    throw new Error("output schema is not supported in ask mode");
  }
  if (request.mode === "plan" && !outputSchemaFile) {
    throw new Error("plan mode requires outputSchemaFile");
  }
  if (request.resumeThreadId) {
    return buildResumeArgs(request, { resultFile, outputSchemaFile, platform });
  }
  return buildInitialArgs(request, { resultFile, outputSchemaFile, platform });
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

  return {
    spec,
    mode,
    workspace,
    resumeThreadId,
    model: normalizeOptionalText(raw.model),
    reasoningEffort: normalizeOptionalText(raw.reasoningEffort),
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
