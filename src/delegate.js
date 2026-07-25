import process from "node:process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCodexArgs,
  validateDelegateInput,
  DEFAULT_WINDOWS_SANDBOX,
  PLAN_SCHEMA,
} from "./command.js";
import { resolveCodex } from "./resolve-codex.js";
import {
  runCodexProcess,
  DEFAULT_HARD_CAP_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STARTUP_MS,
} from "./run-codex.js";
import { normalizeEditToolFiles } from "./edit-tool-files.js";
import { createOperationRegistry } from "./ops.js";

export async function executeDelegate(rawArgs, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    resolve = resolveCodex,
    runProcess = runCodexProcess,
    operationRegistry = createOperationRegistry(),
    onProgress,
    signal: outerSignal,
  } = options;

  if (env.CODEX_DELEGATE_DEPTH && String(env.CODEX_DELEGATE_DEPTH).trim() !== "") {
    const err = new Error(
      "Refusing nested delegation (CODEX_DELEGATE_DEPTH is already set). The orchestrator should call this MCP server, not nest workers."
    );
    err.code = "recursion_refused";
    throw err;
  }

  const request = validateDelegateInput(rawArgs, { cwd });
  // Resolver notes describe the setup, not this run. Emitting them on every
  // result makes a non-empty `warnings` mean nothing; doctor reports them.
  const codex = resolve({ env });
  const warnings = [];

  // Created before the work that can throw, so every exit path has to clean it up.
  const tmp = await mkdtemp(path.join(tmpdir(), "codex-delegate-"));
  let processResult;
  let cancellation;
  try {
    const resultFile = path.join(tmp, "last-message.txt");
    let outputSchemaFile = null;
    if (request.mode === "plan") {
      outputSchemaFile = path.join(tmp, "plan.schema.json");
      await writeFile(outputSchemaFile, JSON.stringify(PLAN_SCHEMA), "utf8");
    }

    const built = buildCodexArgs(request, {
      resultFile,
      outputSchemaFile,
      platform: process.platform,
      windowsSandbox: normalizeText(env.CODEX_DELEGATE_WINDOWS_SANDBOX) ?? DEFAULT_WINDOWS_SANDBOX,
    });

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
      cancel: async () => {
        controller.abort(new Error("cancelled"));
        await settled;
      },
    });

    try {
      processResult = await runProcess({
        command: codex.command,
        args: built.args,
        cwd: request.workspace,
        env,
        resultFile,
        signal: controller.signal,
        timeoutMs: request.timeoutMs ?? envMs(env.CODEX_DELEGATE_HARD_CAP_MS, DEFAULT_HARD_CAP_MS),
        startupMs: envMs(env.CODEX_DELEGATE_STARTUP_MS, DEFAULT_STARTUP_MS),
        heartbeatMs: envMs(env.CODEX_DELEGATE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
        onProgress,
        onThreadId: (id) => lease.updateThreadId(id),
      });
      cancellation = lease.getCancellation();
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
  // In plan mode the final message IS the plan JSON, so returning it verbatim in
  // `result` ships the same payload twice. Once it parses, `plan` carries the
  // structure and `result` keeps only the overview.
  let planResult;
  if (request.mode === "plan" && processResult.finalMessageAvailable) {
    try {
      const parsed = JSON.parse(processResult.result);
      if (!isValidPlanShape(parsed)) {
        warnings.push("Plan mode final message JSON did not match the expected plan schema shape.");
      } else {
        plan = parsed;
        planResult = parsed.overview;
      }
    } catch {
      warnings.push("Plan mode final message was not valid JSON.");
    }
  }

  const resumed =
    Boolean(request.resumeThreadId) && processResult.threadId === request.resumeThreadId;
  const files = normalizeEditToolFiles(
    processResult.filesReportedByEditTools || [],
    request.workspace
  );
  // A cancel that lands after a clean finish cancelled nothing; saying otherwise
  // invites the caller to throw away work that actually landed.
  const lateCancel =
    processResult.status !== "completed" && cancellation?.status === "cancelled";

  // Everything below is omitted when it carries no signal: a field that is
  // present on every call teaches the caller to stop reading it.
  return {
    result: planResult ?? processResult.result,
    resultSource: processResult.resultSource,
    status: processResult.status,
    reason: processResult.reason ?? (lateCancel ? "cancelled" : undefined),
    threadId: processResult.threadId || undefined,
    resumed: request.resumeThreadId ? resumed : undefined,
    workspace: request.workspace,
    cliVersion: codex.version,
    usage: processResult.usage ?? undefined,
    filesReportedByEditTools: files.length ? files : undefined,
    plan,
    warnings: warnings.length ? warnings : undefined,
    exitCode: processResult.status === "completed" ? undefined : processResult.exitCode,
  };
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

function normalizeText(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
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
