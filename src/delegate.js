import process from "node:process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCodexArgs, validateDelegateInput, PLAN_SCHEMA } from "./command.js";
import { resolveCodex } from "./resolve-codex.js";
import {
  runCodexProcess,
  DEFAULT_HARD_CAP_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STARTUP_MS,
} from "./run-codex.js";
import { normalizeEditToolFiles } from "./edit-tool-files.js";
import { createOperationRegistry } from "./ops.js";
import { preflightReviewTarget } from "./git-preflight.js";

const MAX_PLAN_STEPS = 200;

export async function executeDelegate(rawArgs, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    resolve = resolveCodex,
    runProcess = runCodexProcess,
    operationRegistry = createOperationRegistry(),
    onProgress,
    signal: outerSignal,
    preflight = preflightReviewTarget,
  } = options;

  if (env.CODEX_DELEGATE_DEPTH && String(env.CODEX_DELEGATE_DEPTH).trim() !== "") {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(
        "Refusing nested delegation (CODEX_DELEGATE_DEPTH is already set). The orchestrator should call this MCP server, not nest workers."
      )
    );
    err.code = "recursion_refused";
    throw err;
  }

  const request = validateDelegateInput(rawArgs, { cwd });
  if (request.mode === "review") {
    await preflight({ workspace: request.workspace, reviewTarget: request.reviewTarget });
  }
  // Resolver notes describe the setup, not this run. Emitting them on every
  // result makes a non-empty `warnings` mean nothing; doctor reports them.
  const codex = resolve({ env });
  const warnings = [];

  // Created before the work that can throw, so every exit path has to clean it up.
  const tmp = await mkdtemp(path.join(tmpdir(), "codex-delegate-"));
  let processResult;
  let delegationId;
  try {
    const resultFile = path.join(tmp, "last-message.txt");
    let outputSchemaFile = null;
    if (request.mode === "plan") {
      outputSchemaFile = path.join(tmp, "plan.schema.json");
      await writeFile(outputSchemaFile, JSON.stringify(PLAN_SCHEMA), "utf8");
    }

    const built = buildCodexArgs(request, { resultFile, outputSchemaFile });

    const controller = new AbortController();
    const forward = () => controller.abort(outerSignal?.reason);
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort(outerSignal.reason);
      else outerSignal.addEventListener("abort", forward, { once: true });
    }

    // Aborting only *requests* the kill. Resolving cancel on the abort alone
    // reported "cancelled" while codex was still alive; waiting for the run to
    // settle makes the answer true. runCodexProcess bounds this with its kill
    // deadline, so a tree that refuses to die cannot hang the cancel either.
    let markSettled;
    const settled = new Promise((resolve) => {
      markSettled = resolve;
    });

    const lease = operationRegistry.acquire({
      threadId: request.resumeThreadId || null,
      workspace: request.workspace,
      cancel: async () => {
        controller.abort(new Error("cancelled"));
        await settled;
      },
    });
    warnings.push(...(lease.warnings || []));
    // Announced before the spawn, and before Codex has a thread id to announce:
    // this is the only handle a caller has for cancelling a run that wedges during
    // startup, and it arrives too late to be useful if it waits for the result.
    delegationId = lease.delegationId;
    onProgress?.(`delegation id: ${lease.delegationId}`);

    try {
      processResult = await runProcess({
        command: codex.command,
        args: built.args,
        cwd: request.workspace,
        env,
        resultFile,
        stdin: built.stdin,
        signal: controller.signal,
        timeoutMs: request.timeoutMs ?? envMs(env.CODEX_DELEGATE_HARD_CAP_MS, DEFAULT_HARD_CAP_MS),
        startupMs: envMs(env.CODEX_DELEGATE_STARTUP_MS, DEFAULT_STARTUP_MS),
        heartbeatMs: envMs(env.CODEX_DELEGATE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
        onProgress,
        onThreadId: (id) => lease.updateThreadId(id),
      });
    } finally {
      markSettled();
      lease.release();
      if (outerSignal) outerSignal.removeEventListener("abort", forward);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  warnings.push(...(processResult.warnings || []));

  let plan;
  let planResult;
  let status = processResult.status;
  let reason = processResult.reason;
  let result = processResult.result;
  if (request.mode === "plan" && status === "completed") {
    // Plan mode promised structured output: the final message IS the plan JSON,
    // so returning it verbatim in `result` would ship the same payload twice.
    // Once it parses, `plan` carries the structure and `result` keeps only the
    // overview. Text that is not a valid plan is a failed result contract, not
    // a completed run with a warning and raw salvage.
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {}
    if (parsed && isValidPlanShape(parsed)) {
      if (parsed.steps.length > MAX_PLAN_STEPS) {
        // The step list is model-authored and unbounded; a 2000-step plan is a
        // malfunction, and shipping all of it costs the caller more than the tail
        // of it is worth.
        plan = { ...parsed, steps: parsed.steps.slice(0, MAX_PLAN_STEPS) };
        warnings.push(
          `Plan had ${parsed.steps.length} steps; only the first ${MAX_PLAN_STEPS} are returned.`
        );
      } else {
        plan = parsed;
      }
      planResult = parsed.overview;
    } else {
      status = "failed";
      reason = "result-unavailable";
      result = "";
    }
  }

  const resumed =
    Boolean(request.resumeThreadId) && processResult.threadId === request.resumeThreadId;
  const files = normalizeEditToolFiles(
    processResult.filesReportedByEditTools || [],
    request.workspace
  );
  // Everything below is omitted when it carries no signal: a field that is
  // present on every call teaches the caller to stop reading it.
  return {
    result: planResult ?? result,
    status,
    // Every outcome that is not `completed` names its own reason, cancellation
    // included: the run reads the cancel flag on the exit that decides the outcome,
    // so there is nothing left for this layer to add.
    reason,
    threadId: processResult.threadId || undefined,
    delegationId,
    resumed: request.resumeThreadId ? resumed : undefined,
    workspace: request.workspace,
    cliVersion: codex.version,
    usage: processResult.usage ?? undefined,
    filesReportedByEditTools: files.length ? files : undefined,
    plan,
    warnings: warnings.length ? warnings : undefined,
    exitCode: status === "completed" ? undefined : toExitCode(processResult.exitCode),
  };
}

/**
 * Output validation rejects the payload *after* the run finished, so one
 * malformed field costs the caller the entire result. An exit code we cannot
 * vouch for is worth less than the thread id and file list it would take down.
 */
function toExitCode(value) {
  return Number.isInteger(value) ? value : undefined;
}

/**
 * A malformed or negative knob falls back to its default rather than arming a
 * deadline that fails every call. Explicit 0 disables the guard it belongs to.
 */
export function envMs(raw, fallback) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

function isValidPlanShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.overview !== "string") return false;
  if (!Array.isArray(value.steps)) return false;
  return value.steps.every(
    (step) =>
      step &&
      typeof step === "object" &&
      typeof step.title === "string" &&
      typeof step.detail === "string"
  );
}
