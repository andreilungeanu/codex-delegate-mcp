#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  MODES,
  REASONING_EFFORTS,
} from "./command.js";
import { executeDelegate as executeDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { createOperationRegistry } from "./ops.js";
import { VERSION } from "./version.js";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`codex-delegate-mcp requires Node 20+ (found ${process.versions.node})`);
  process.exit(1);
}

export const SERVER_INSTRUCTIONS = `Delegate coding work to the OpenAI Codex CLI through the delegate tool. You orchestrate (brief + review); Codex implements. Codex runs unsandboxed in every mode, so it can write anywhere the user account can reach — no mode is read-only. Scope workspace tightly and review the git diff after every run. doctor reports setup problems.`;

const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z.object({ kind: z.literal("base"), branch: z.string() }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string() }).strict(),
]);

// No tool declares an outputSchema: declaring one obliges the server to also return
// structuredContent, and a host that reads both it and the text block — Codex does — puts the
// payload in the model's context twice. Every tool returns one compact JSON text block instead.
// So this is an in-repo contract, enforced by the .strict() copy in server.test.js, which
// fails when a field added in delegate.js is forgotten here. cancel's status vocabulary is
// published in its tool description, which is now its only schema.
//
// Types only. What each field means, and what its absence means, is documented once in
// skills/delegate/reference.md.
export const delegateOutputShape = {
  result: z.string(),
  resultSource: z.literal("stream-fallback").optional(),
  status: z.enum(["completed", "failed", "interrupted"]),
  reason: z
    .enum([
      "cancelled",
      "startup-timeout",
      "hard-cap",
      "agent-error",
      "died-mid-turn",
      "exit-nonzero",
    ])
    .optional(),
  threadId: z.string().optional(),
  delegationId: z.string().optional(),
  resumed: z.boolean().optional(),
  workspace: z.string(),
  cliVersion: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      cacheWriteInputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      reasoningOutputTokens: z.number().optional(),
    })
    .optional(),
  filesReportedByEditTools: z.array(z.string()).optional(),
  plan: z
    .object({
      overview: z.string(),
      steps: z.array(
        z.object({
          title: z.string(),
          detail: z.string(),
        })
      ),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(),
};

/** @param {{ args?: any, operationRegistry: any }} params */
export async function runCancelTool({ args = {}, operationRegistry }) {
  try {
    const result = await operationRegistry.cancel({
      id: args?.delegationId || args?.threadId || null,
      cause: "user",
    });
    return {
      content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(result) }],
    };
  } catch (err) {
    const payload = {
      error: err?.code || "cancel_failed",
      message: err?.message || String(err),
    };
    return {
      content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

export async function runDelegateTool({
  args,
  extra,
  execute = executeDelegateDefault,
  operationRegistry,
}) {
  const progressToken = extra?._meta?.progressToken;
  /** @type {(message: string) => void} */
  let onProgress = () => {};
  if (progressToken != null) {
    let progress = 0;
    onProgress = (message) => {
      try {
        extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++progress, message },
        });
      } catch {}
    };
  }

  try {
    const result = await execute(args, {
      operationRegistry,
      onProgress,
      signal: extra?.signal,
    });
    return {
      content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(result) }],
    };
  } catch (err) {
    const payload = {
      error: err?.code || "delegate_failed",
      message: err?.message || String(err),
    };
    if (err?.details) payload.details = err.details;
    return {
      content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

/**
 * @param {{
 *   executeDelegate?: any,
 *   doctorRunner?: any,
 *   operationRegistry?: any,
 * }} [options]
 */
export function buildServer({
  executeDelegate = executeDelegateDefault,
  doctorRunner = runDoctorDefault,
  operationRegistry = createOperationRegistry(),
} = {}) {
  const server = new McpServer(
    { name: "codex-delegate-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "delegate",
    {
      description:
        "Delegate a coding task to the OpenAI Codex CLI. Never shell out to codex — use this tool. mode: agent edits, plan returns a structured plan, ask answers questions, review runs Codex's native review. mode is an instruction to Codex, not a sandbox: Codex runs unsandboxed and can write outside the workspace in any mode, so review the git diff after every run. Change model/reasoningEffort/fast only when the user asks. See the delegate skill for orchestration.",
      // Strict: an unknown key is almost always a typo, and a silently dropped
      // `resumeThredId` loses the thread with nothing to show for it.
      inputSchema: z.object({
        spec: z
          .string()
          .describe(
            "Task brief: goal, scope, decisions already made (quote the user's exact values), acceptance criteria. Point at files to read rather than pasting code."
          ),
        mode: z.enum([...MODES]).default("agent"),
        workspace: z
          .string()
          .optional()
          .describe(
            "Working directory for Codex. Optional; defaults to the server process cwd, which for npx and plugin launches is not necessarily your project root — pass it explicitly. Smallest directory holding the task's files; none → project root. Must already exist — never create one for the call. Required when resuming: codex exec resume has no --cd."
          ),
        resumeThreadId: z
          .string()
          .optional()
          .describe("Resume an existing Codex thread instead of starting a new one"),
        model: z
          .string()
          .default(DEFAULT_MODEL)
          .describe("Codex model id"),
        reasoningEffort: z
          .enum([...REASONING_EFFORTS])
          .default(DEFAULT_REASONING_EFFORT)
          .describe("Reasoning effort. gpt-5.6-* reject minimal; older models reject none"),
        fast: z
          .boolean()
          .default(false)
          .describe("Codex Fast mode (service_tier=fast) — higher credit use"),
        webSearch: z
          .boolean()
          .default(true)
          .describe(
            "Web search. false disables it. Does not seal the run: Codex is unsandboxed, so its shell reaches the network either way"
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(86_400_000)
          .optional()
          .describe(
            "Hard-cap timeout in milliseconds (default 1h). A long silent command is not a timeout; only the 60s spawn-to-first-output deadline is."
          ),
        reviewTarget: reviewTargetSchema
          .optional()
          .describe("Required in review mode: uncommitted, base branch, or commit sha"),
      }).strict(),
      annotations: {
        title: "Delegate coding task to Codex",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      runDelegateTool({ args, extra, execute: executeDelegate, operationRegistry })
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Cancel in-flight Codex delegations owned by this server. Returns once the processes have actually ended, not when the kill was requested. Name one with delegationId (announced in progress before the run starts, and the only handle for a run that wedges during startup) or threadId (cancels every delegation on that thread). With neither, every active delegation is cancelled. Returns a status of cancelled, nothing-active, not-running, or not-found.",
      inputSchema: z
        .object({
          delegationId: z
            .string()
            .optional()
            .describe("Cancel this one delegation, by the id announced in its progress stream"),
          threadId: z
            .string()
            .optional()
            .describe("Cancel every delegation running on this Codex thread"),
        })
        .strict(),
      annotations: {
        title: "Cancel Codex delegation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => runCancelTool({ args, operationRegistry })
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Report setup diagnostics: plugin version, Codex CLI resolution, login status, recursion guard. deep=true runs help-only surface checks (no model quota).",
      inputSchema: z
        .object({
          deep: z
            .boolean()
            .default(false)
            .describe("When true, probe codex exec/review/resume --help surfaces"),
          workspace: z.string().optional(),
        })
        .strict(),
      annotations: {
        title: "Diagnose Codex delegation setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deep, workspace }) => {
      const out = await doctorRunner({
        deep,
        workspace: workspace || process.cwd(),
        getClientInfo: () => ({
          capabilities: server.server.getClientCapabilities(),
          version: server.server.getClientVersion(),
        }),
      });
      return {
        content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(out) }],
      };
    }
  );

  return server;
}

const __filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {}
}

if (isMain) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
