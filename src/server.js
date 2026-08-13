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

export const SERVER_INSTRUCTIONS = `Hand coding work to Codex via the delegate tool; never shell out to codex. Auto-approved in every mode: agent/plan/ask/review reach any file the user account can, and the network. mode instructs, it does not limit. Review the git diff after every run.`;

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
      // sendNotification is async: a rejection settles outside this try, and an
      // unhandled one exits the process — taking every concurrent delegation with
      // it. A host that drops mid-run is the trigger, and the heartbeat drives this
      // path all turn. The try stays for a sync throw, which lands while the call
      // is still being made and so before Promise.resolve can wrap it.
      try {
        Promise.resolve(
          extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: ++progress, message },
          })
        ).catch(() => {});
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
        "Delegate a coding task to OpenAI Codex. Never run codex from the shell — use this tool. Check status before trusting result — a run that spawns then fails returns normally. Keep model, reasoningEffort and fast at their defaults unless the user asks. See the delegate skill.",
      // Strict: an unknown key is almost always a typo, and a silently dropped
      // `resumeThredId` loses the thread with nothing to show for it.
      inputSchema: z.object({
        spec: z
          .string()
          .describe(
            "Brief with goal, scope, fixed decisions quoted exactly, and acceptance criteria; reference files instead of pasting code."
          ),
        mode: z
          .enum([...MODES])
          .default("agent")
          .describe(
            "agent implements; plan returns a structured plan; ask answers; review runs native review."
          ),
        workspace: z
          .string()
          .optional()
          .describe(
            "Codex's working directory; not confinement. Must already exist — never create one for the call. Defaults to the server cwd, often not the project root under npx/plugin. Required on resume: resume has no --cd."
          ),
        resumeThreadId: z
          .string()
          .optional()
          .describe("Thread to continue. Reuse its workspace. Forbidden with review."),
        model: z
          .string()
          .default(DEFAULT_MODEL)
          .describe(
            "Codex model id: gpt-5.6-terra, gpt-5.6-sol, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini and more."
          ),
        reasoningEffort: z
          .enum([...REASONING_EFFORTS])
          .default(DEFAULT_REASONING_EFFORT)
          .describe("gpt-5.6-* reject minimal; older models reject none."),
        fast: z.boolean().default(false).describe("Codex Fast mode; higher credit use."),
        webSearch: z.boolean().default(true).describe("Codex's built-in web search."),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(86_400_000)
          .optional()
          .describe(
            "Whole-run cap in ms (default 1h). Mid-turn silence is allowed; startup has a separate 60s first-output deadline."
          ),
        reviewTarget: reviewTargetSchema
          .optional()
          .describe("Required in review; forbidden otherwise: uncommitted, base branch, or commit."),
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
        "Cancel active runs. delegationId selects one (announced in progress before spawn — the only handle if a run wedges at startup), threadId all on its thread, neither all. Waits for settlement; if a process tree survives the kill deadline, it still returns and the delegate result warns. Status: cancelled, nothing-active, not-running, or not-found.",
      inputSchema: z
        .object({
          delegationId: z.string().optional(),
          threadId: z.string().optional(),
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
        "Diagnose plugin/CLI/login, recursion, and workspace (default: server cwd). deep adds no-quota exec/review/resume help checks.",
      inputSchema: z
        .object({
          deep: z.boolean().default(false),
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
  // Without this the transport starts and waits on stdin forever, so `--version`
  // looks exactly like a wedged install — and doctor cannot answer "is this even
  // the right binary?" until a host is already wired up. No other flag is parsed:
  // treating an unknown one as --help would break `npx -y` with stray args.
  if (process.argv.slice(2).includes("--version")) {
    console.log(VERSION);
  } else {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
  }
}
