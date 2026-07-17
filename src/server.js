#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeDelegate as executeDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { createOperationRegistry } from "./ops.js";
import { VERSION } from "./version.js";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 18) {
  console.error(`codex-delegate-mcp requires Node 18+ (found ${process.versions.node})`);
  process.exit(1);
}

export const SERVER_INSTRUCTIONS = `Delegate coding work to the OpenAI Codex CLI through the delegate tool. You orchestrate (brief + review); Codex implements. Defaults: model=gpt-5.6-terra, reasoningEffort=high, network=false (fast is always off). Override model/reasoningEffort only when the user asks. Use mode="agent" for edits, mode="plan" for a structured plan, mode="ask" for read-only Q&A, mode="review" for native code review. Scope workspace tightly. Review touchedFiles and the git diff after write-capable runs. Use doctor for setup diagnostics.`;

const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z.object({ kind: z.literal("base"), branch: z.string() }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string() }).strict(),
]);

const delegateOutputSchema = z
  .object({
    result: z.string(),
    finalMessageAvailable: z.boolean(),
    status: z.enum(["completed", "failed", "interrupted"]),
    threadId: z.string().optional(),
    resumed: z.boolean(),
    mode: z.enum(["agent", "plan", "ask", "review"]),
    workspace: z.string(),
    touchedFiles: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .passthrough();

export async function runCancelTool({ args = {}, operationRegistry }) {
  const result = await operationRegistry.cancel({
    threadId: args?.threadId,
    cause: "user",
  });
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

export async function runDelegateTool({
  args,
  extra,
  execute = executeDelegateDefault,
  operationRegistry,
}) {
  const progressToken = extra?._meta?.progressToken;
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
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (err) {
    const payload = {
      error: err?.code || "delegate_failed",
      message: err?.message || String(err),
    };
    if (err?.details) payload.details = err.details;
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
}

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
        "Delegate a coding task to the OpenAI Codex CLI. Never shell out to codex — use this tool. Pass a precise brief in spec. Defaults: mode=agent, model=gpt-5.6-terra, reasoningEffort=high, network=false (fast is always off). Override model/reasoningEffort only when the user asks. Plan workflow: mode=plan then resume with mode=agent and resumeThreadId. Returns the authoritative final message, thread id, changed files, and warnings. See the delegate skill for orchestration.",
      inputSchema: {
        spec: z
          .string()
          .describe(
            "Task brief: goal, scope, decisions already made (quote the user's exact values), acceptance criteria. Point at files to read rather than pasting code."
          ),
        mode: z.enum(["agent", "plan", "ask", "review"]).default("agent"),
        workspace: z.string().optional().describe("Working directory for Codex (defaults to cwd)"),
        resumeThreadId: z
          .string()
          .optional()
          .describe("Resume an existing Codex thread instead of starting a new one"),
        model: z
          .string()
          .default("gpt-5.6-terra")
          .describe("Codex model id. Default gpt-5.6-terra; override only when the user asks"),
        reasoningEffort: z
          .enum(["minimal", "low", "medium", "high", "xhigh"])
          .default("high")
          .describe("Reasoning effort. Default high; override only when the user asks"),
        network: z
          .boolean()
          .default(false)
          .describe("Allow network access (agent mode only)"),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(86_400_000)
          .optional()
          .describe("Overall turn timeout in milliseconds"),
        reviewTarget: reviewTargetSchema
          .optional()
          .describe("Required in review mode: uncommitted, base branch, or commit sha"),
      },
      outputSchema: delegateOutputSchema,
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
        "Cancel the in-flight Codex delegation owned by this server. Optional threadId prevents cancelling a different active thread.",
      inputSchema: {
        threadId: z.string().optional().describe("Cancel only when this thread is active"),
      },
      outputSchema: z
        .object({
          status: z.enum(["cancelled", "nothing-active", "not-owned"]),
        })
        .passthrough(),
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
      inputSchema: {
        deep: z
          .boolean()
          .default(false)
          .describe("When true, probe codex exec/review/resume --help surfaces"),
        workspace: z.string().optional(),
      },
      outputSchema: z
        .object({
          plugin: z.object({ version: z.string() }).passthrough(),
          codex: z.object({ found: z.boolean() }).passthrough(),
          runtime: z.object({ node: z.string(), platform: z.string() }).passthrough(),
          warnings: z.array(z.string()),
        })
        .passthrough(),
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
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
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
