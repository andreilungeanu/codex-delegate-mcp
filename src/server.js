#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  MODES,
} from "./command.js";
import { executeDelegate as executeDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { readModelCatalog, listedSlugs, listedEfforts, modelEfforts } from "./model-catalog.js";
import { createOperationRegistry } from "./ops.js";
import { installSignalCleanup } from "./shutdown.js";
import { resolveCodex } from "./resolve-codex.js";
import { TASKS_EXTENSION, createTaskStore, listsTasks, registerTaskHandlers, runAsTask } from "./tasks.js";
import { VERSION } from "./version.js";

const ICON_BASE = `https://raw.githubusercontent.com/andreilungeanu/codex-delegate-mcp/v${VERSION}/assets`;
/** @type {Array<{ src: string, mimeType: string, sizes: string[], theme: "light" | "dark" }>} */
const SERVER_ICONS = [
  { src: `${ICON_BASE}/logo-light.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "light" },
  { src: `${ICON_BASE}/logo-dark.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "dark" },
];
const SERVER_INFO = {
  name: "codex-delegate-mcp",
  title: "Codex Delegate",
  description: "Bridge AI coding hosts to the OpenAI Codex CLI for delegated implementation.",
  version: VERSION,
  websiteUrl: "https://github.com/andreilungeanu/codex-delegate-mcp",
  icons: SERVER_ICONS,
};

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`codex-delegate-mcp requires Node 20+ (found ${process.versions.node})`);
  process.exit(1);
}

// Shared by every server the factory builds, so a task outlives the request that started it.
const taskStore = createTaskStore();

export const SERVER_INSTRUCTIONS = `Hand coding work to Codex via the delegate tool; never shell out to codex. Auto-approved in every mode: agent/plan/ask/review reach any file the user account can, and the network. mode instructs, it does not limit. Review the git diff after every run.`;

const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z.object({ kind: z.literal("base"), branch: z.string() }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string() }).strict(),
]);

/** @param {{ args?: any, operationRegistry: any }} params */
export async function runCancelTool({ args = {}, operationRegistry }) {
  const [delegationId, threadId] = [args?.delegationId, args?.threadId].map((id) =>
    typeof id === "string" ? id.trim() : id
  );
  // A blank id would fall through to cancel-all, which only omitting both selectors asks for.
  if (delegationId === "" || threadId === "") {
    const payload = { error: "invalid_id", message: "A blank id selects no run. Omit both ids to cancel every run." };
    return {
      content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(payload) }],
      isError: true,
    };
  }
  try {
    const result = await operationRegistry.cancel({
      id: delegationId || threadId || null,
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

/**
 * Progress notifications for a request that carries a progress token; a no-op otherwise.
 *
 * @param {any} ctx
 * @returns {(message: string) => void}
 */
export function progressNotifier(ctx) {
  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  if (progressToken == null) return () => {};
  let progress = 0;
  return (message) => {
    // notify is async: a rejection settles outside this try, and an
    // unhandled one exits the process — taking every concurrent delegation with
    // it. A host that drops mid-run is the trigger, and the heartbeat drives this
    // path all turn. The try stays for a sync throw, which lands while the call
    // is still being made and so before Promise.resolve can wrap it.
    try {
      Promise.resolve(
        ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: ++progress, message },
        })
      ).catch(() => {});
    } catch {}
  };
}

/**
 * A run as an MCP task passes its own signal and onProgress, and executeDelegate's task options.
 *
 * @param {{
 *   args: any,
 *   ctx?: any,
 *   execute?: any,
 *   operationRegistry?: any,
 *   signal?: AbortSignal,
 *   onProgress?: (message: string) => void,
 *   [option: string]: any,
 * }} deps
 */
export async function runDelegateTool({
  args,
  ctx,
  execute = executeDelegateDefault,
  operationRegistry,
  signal = ctx?.mcpReq?.signal,
  onProgress = progressNotifier(ctx),
  ...runOptions
}) {
  try {
    const result = await execute(args, {
      operationRegistry,
      onProgress,
      signal,
      ...runOptions,
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
 * Deadline for the catalog read at startup. `codex debug models` answers from Codex's own
 * cache while it is under five minutes old and was written by the same CLI version, and
 * fetches the catalog again otherwise — the usual state when a session starts, and more
 * often beside the Codex app, whose own CLI builds share the cache: 614-1817ms measured on
 * Windows with CLI 0.159.3, against ~100ms from a fresh cache. 5s is the budget Codex gives its own catalog refresh
 * after a login change, well inside the 30s Codex and Claude Code allow a server to start.
 */
const STARTUP_CATALOG_MS = 5000;

/**
 * The catalog the model field is described from, read once before the transport starts: a
 * host asks for the tool list when it connects and keeps it for the session. Null when no
 * CLI resolves or it does not answer in time.
 *
 * @param {{ env?: NodeJS.ProcessEnv, resolve?: any, readCatalog?: any }} [options]
 * @returns {Promise<any[] | null>}
 */
export async function readStartupCatalog({
  env = process.env,
  resolve = resolveCodex,
  readCatalog = readModelCatalog,
} = {}) {
  let command;
  let commandArgs;
  try {
    ({ command, commandArgs = [] } = resolve({ env }));
  } catch {
    return null;
  }
  return readCatalog({ command, commandArgs, timeoutMs: STARTUP_CATALOG_MS });
}

/**
 * What the CLI lists, default first. With no list to name, the field points at doctor
 * rather than at a list nobody checked.
 *
 * @param {any[] | null} catalog
 */
function describeModelField(catalog) {
  const listed = listedSlugs(catalog);
  if (listed.length === 0) return "Codex model id. doctor deep:true lists every id.";
  const ordered = listed.includes(DEFAULT_MODEL)
    ? [DEFAULT_MODEL, ...listed.filter((slug) => slug !== DEFAULT_MODEL)]
    : listed;
  return `Codex model id: ${ordered.join(", ")}.`;
}

/**
 * The levels the same catalog lists, and which models stop short of the highest. The catalog
 * lists each model's levels lowest first, so the last is its top. Without a list it points at
 * doctor, as the model field does.
 *
 * @param {any[] | null} catalog
 */
function describeEffortField(catalog) {
  const levels = listedEfforts(catalog);
  if (levels.length === 0) return "Codex reasoning level. doctor deep:true lists each model's levels.";
  const top = levels[levels.length - 1];
  /** @type {Map<string, string[]>} */
  const lower = new Map();
  for (const slug of listedSlugs(catalog)) {
    const own = modelEfforts(catalog, slug);
    const ownTop = own?.[own.length - 1];
    if (!ownTop || ownTop === top) continue;
    lower.set(ownTop, [...(lower.get(ownTop) || []), slug]);
  }
  const short = [...lower].map(([level, slugs]) => `${level} on ${slugs.join(", ")}`).join("; ");
  return [
    `Codex reasoning level: ${levels.join(", ")}.`,
    short ? `Tops out at ${short}.` : "",
    "A level the model does not advertise is forwarded, with a warning.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {{
 *   executeDelegate?: any,
 *   doctorRunner?: any,
 *   operationRegistry?: any,
 *   catalog?: any[] | null,
 *   era?: "legacy" | "modern",
 *   tasks?: ReturnType<typeof createTaskStore>,
 * }} [options]
 */
export function buildServer({
  executeDelegate = executeDelegateDefault,
  doctorRunner = runDoctorDefault,
  operationRegistry = createOperationRegistry(),
  catalog = null,
  era,
  tasks = taskStore,
} = {}) {
  // Tasks only on a 2026-07-28 instance: the SDK also lifts envelope keys off 2025-era requests.
  const servesTasks = era === "modern";
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: {
      // The tool list never changes, and the SDK advertises listChanged unless told otherwise.
      tools: { listChanged: false },
      ...(servesTasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {}),
    },
  });
  if (servesTasks) registerTaskHandlers(server, tasks);

  server.registerTool(
    "delegate",
    {
      description:
        "Delegate a coding task to OpenAI Codex. Never run codex from the shell — use this tool. Check status before trusting result — a run that spawns then fails returns normally. Set spec, workspace and mode, plus resumeThreadId to resume and reviewTarget in review; leave every other field at its default unless the user asks. See the delegate skill.",
      // Strict: an unknown key is almost always a typo, and a silently dropped
      // `resumeThreadId` loses the thread with nothing to show for it.
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
          .describe(
            "Codex's working directory; not confinement. Must already exist — never create one for the call."
          ),
        resumeThreadId: z
          .string()
          .optional()
          .describe("Thread to continue, or the task id of a delegate run as an MCP task. Reuse its workspace. Forbidden with review."),
        model: z
          .string()
          .default(DEFAULT_MODEL)
          .describe(describeModelField(catalog)),
        reasoningEffort: z
          .string()
          .default(DEFAULT_REASONING_EFFORT)
          .describe(describeEffortField(catalog)),
        fast: z.boolean().default(false).describe("Codex Fast mode; higher credit use."),
        webSearch: z.boolean().default(true).describe("Codex's built-in web search."),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(86_400_000)
          .optional()
          .describe(
            "Whole-run cap in ms (default 6h). Mid-turn silence is allowed; startup has a separate 60s first-output deadline."
          ),
        reviewTarget: reviewTargetSchema
          .optional()
          .describe("Required in review; forbidden otherwise: uncommitted, base branch, or commit."),
      }).strict(),
      title: "Delegate coding task to Codex",
      annotations: {
        title: "Delegate coding task to Codex",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      // Claude Code shows the model a task's id and never its thread id, even after a stop.
      const resumeThreadId = tasks.threadOf(args.resumeThreadId?.trim()) ?? args.resumeThreadId;
      /** @param {Record<string, any>} [over] */
      const run = (over) =>
        runDelegateTool({
          args: { ...args, resumeThreadId },
          ctx,
          // The same snapshot the description names, so a model it offers is not read again.
          execute: (input, options) => executeDelegate(input, { ...options, catalog }),
          operationRegistry,
          ...over,
        });
      if (!servesTasks || !listsTasks(ctx)) return run();
      return /** @type {any} */ (
        runAsTask({ run, signal: ctx?.mcpReq?.signal, notify: progressNotifier(ctx), store: tasks })
      );
    }
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Cancel active runs. delegationId selects one (announced in progress before spawn — the only handle if a run wedges at startup; a delegate task's id is its delegationId), threadId all on its thread, neither all. Waits for settlement; if the stop cannot confirm the exit, it still returns and the delegate result warns. Status: cancelled, nothing-active, or not-found (no active run with this ID).",
      inputSchema: z
        .object({
          delegationId: z.string().optional(),
          threadId: z.string().optional(),
        })
        .strict(),
      title: "Cancel Codex delegation",
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
        "Diagnose plugin/CLI/login, recursion, and workspace (default: server cwd). deep adds no-quota help and model-catalog checks.",
      inputSchema: z
        .object({
          deep: z.boolean().default(false),
          workspace: z.string().optional(),
        })
        .strict(),
      title: "Diagnose Codex delegation setup",
      annotations: {
        title: "Diagnose Codex delegation setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deep, workspace }, ctx) => {
      const out = await doctorRunner({
        deep,
        workspace: workspace || process.cwd(),
        getClientInfo: () => clientInfoOf(server, ctx),
      });
      return {
        content: [{ type: /** @type {"text"} */ ("text"), text: JSON.stringify(out) }],
      };
    }
  );

  return server;
}

/**
 * A 2025-era host declares itself once, in initialize, which the server's getters return; a
 * 2026-07-28 host sends its identity with each request. initialize wins where there was one.
 *
 * @param {McpServer} server
 * @param {any} ctx
 */
export function clientInfoOf(server, ctx) {
  const envelope = ctx?.mcpReq?.envelope;
  return {
    capabilities: server.server.getClientCapabilities() ?? envelope?.[CLIENT_CAPABILITIES_META_KEY],
    version: server.server.getClientVersion() ?? envelope?.[CLIENT_INFO_META_KEY],
    protocolVersion: server.server.getNegotiatedProtocolVersion() ?? envelope?.[PROTOCOL_VERSION_META_KEY],
  };
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
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
  } else {
    const operationRegistry = createOperationRegistry();
    const hostGone = installSignalCleanup(() => operationRegistry.cancel({ cause: "shutdown" }));
    const catalog = await readStartupCatalog();
    const transport = new StdioServerTransport();
    // One factory serves both protocol eras, and only a 2026-07-28 instance answers with tasks. The
    // registry and catalog are shared, so a cancel reaches every run and the catalog is read once.
    serveStdio(({ era }) => buildServer({ era, operationRegistry, catalog }), { transport });
    // The transport also closes on a broken stdout, and then pauses stdin, so no 'end' arrives.
    const closeServers = transport.onclose;
    transport.onclose = () => {
      closeServers?.();
      hostGone();
    };
  }
}
