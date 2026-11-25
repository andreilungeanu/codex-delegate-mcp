// The MCP surface a host talks to, through serveStdio (the production entry) over an
// in-memory transport: the handshake, tool listing, and a delegate call round trip with
// input schema validation, progress notifications and result serialization.
import { afterAll, beforeAll, bench, describe } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../src/server.js";
import { brief, CATALOG } from "./fixtures.js";

const workspace = process.cwd();
const spec = brief(30);

/** What executeDelegate returns for a completed agent run, without running Codex. */
const delegateResult = {
  result: "Done. All modules updated and tests pass.\n".repeat(40),
  status: "completed",
  threadId: "019a-bench-thread",
  delegationId: "d-bench",
  workspace,
  cliVersion: "0.160.0",
  usage: { scope: "thread", inputTokens: 482_113, cachedInputTokens: 401_920, outputTokens: 18_204 },
  filesReportedByEditTools: Array.from({ length: 40 }, (_, i) => `src/module-${i}.js`),
  warnings: ["Codex notice: Model metadata for `gpt-6-luna` not found."],
};

async function stubDelegate(_args, { onProgress }) {
  for (let i = 0; i < 10; i++) onProgress?.(`running: npm test -- test/module-${i}.test.js`);
  return delegateResult;
}

async function connect() {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ era, catalog: CATALOG, executeDelegate: stubDelegate }), {
    transport: serverTransport,
  });
  const client = new Client({ name: "bench-host", version: "1.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await served.close();
    },
  };
}

let session;
beforeAll(async () => {
  session = await connect();
});
afterAll(async () => {
  await session?.close();
});

describe("MCP server", () => {
  bench("connect and initialize", async () => {
    const { close } = await connect();
    await close();
  });

  bench("tools/list", async () => {
    await session.client.listTools();
  });

  bench("delegate call with progress", async () => {
    const out = await session.client.callTool(
      { name: "delegate", arguments: { spec, workspace, mode: "agent" } },
      { onprogress: () => {} }
    );
    if (out.isError) throw new Error(out.content[0].text);
  });
});
