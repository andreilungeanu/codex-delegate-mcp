import process from "node:process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCodexArgs, validateDelegateInput, PLAN_SCHEMA } from "./command.js";
import { resolveCodex } from "./resolve-codex.js";
import { runCodexProcess, DEFAULT_HARD_CAP_MS } from "./run-codex.js";
import { normalizeAgentReportedFiles } from "./agent-reported-files.js";
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
  const codex = resolve({ env });
  const warnings = [...(codex.warnings || [])];

  const tmp = await mkdtemp(path.join(tmpdir(), "codex-delegate-"));
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
  });

  const controller = new AbortController();
  const forward = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener("abort", forward, { once: true });
  }

  const lease = operationRegistry.acquire({
    threadId: request.resumeThreadId || null,
    cancel: async () => {
      controller.abort(new Error("cancelled"));
    },
  });

  let processResult;
  try {
    processResult = await runProcess({
      command: codex.command,
      args: built.args,
      cwd: request.workspace,
      env,
      resultFile,
      signal: controller.signal,
      timeoutMs: request.timeoutMs ?? DEFAULT_HARD_CAP_MS,
      onProgress,
      onThreadId: (id) => lease.updateThreadId(id),
    });
  } finally {
    lease.release();
    if (outerSignal) outerSignal.removeEventListener("abort", forward);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  warnings.push(...(processResult.warnings || []));

  let plan;
  if (request.mode === "plan" && processResult.finalMessageAvailable) {
    try {
      const parsed = JSON.parse(processResult.result);
      if (!isValidPlanShape(parsed)) {
        warnings.push("Plan mode final message JSON did not match the expected plan schema shape.");
      } else {
        plan = parsed;
      }
    } catch {
      warnings.push("Plan mode final message was not valid JSON.");
    }
  }

  const cancellation = lease.getCancellation();
  return {
    result: processResult.result,
    finalMessageAvailable: processResult.finalMessageAvailable,
    status: processResult.status,
    threadId: processResult.threadId || request.resumeThreadId || undefined,
    resumed: Boolean(request.resumeThreadId),
    mode: request.mode,
    workspace: request.workspace,
    cliVersion: codex.version,
    filesReportedByAgent: normalizeAgentReportedFiles(
      processResult.filesReportedByAgent || [],
      request.workspace
    ),
    plan,
    warnings,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled || cancellation?.status === "cancelled",
    exitCode: processResult.exitCode,
  };
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
