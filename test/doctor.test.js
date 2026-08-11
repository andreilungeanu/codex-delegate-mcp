import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/doctor.js";
import { VERSION } from "../src/version.js";

const resolved = {
  command: "/bin/codex",
  source: "standalone",
  version: "0.145.0",
  warnings: [],
};

function options(overrides = {}) {
  return {
    workspace: process.cwd(),
    env: {},
    resolve: () => resolved,
    execFileImpl: async () => ({ stdout: "Logged in", stderr: "" }),
    ...overrides,
  };
}

test("doctor reports a resolved CLI, login and runtime", async () => {
  const out = await runDoctor(options());

  assert.equal(out.plugin.version, VERSION);
  assert.equal(out.plugin.name, "codex-delegate-mcp");
  assert.equal(out.codex.found, true);
  assert.equal(out.codex.command, "/bin/codex");
  assert.equal(out.codex.version, "0.145.0");
  assert.equal(out.login.status, "ok");
  assert.equal(out.login.detail, "Logged in");
  assert.equal(out.workspace.path, process.cwd());
  assert.equal(out.workspace.exists, true);
  assert.equal(out.workspace.isGitRepo, true);
  assert.equal(out.runtime.transport, "stdio");
  assert.deepEqual(out.warnings, []);
  assert.equal(out.deep, undefined);
});

test("doctor flags a workspace that is not there", async () => {
  const out = await runDoctor(options({ workspace: "/no/such/workspace" }));

  assert.equal(out.workspace.exists, false);
  assert.equal(out.workspace.isGitRepo, undefined);
  assert.match(out.warnings.join("\n"), /workspace does not exist/);
});

test("doctor surfaces a resolution failure instead of throwing", async () => {
  const out = await runDoctor(
    options({
      resolve: () => {
        const err = new Error("Codex CLI not found.");
        err.code = "not_found";
        throw err;
      },
    })
  );

  assert.equal(out.codex.found, false);
  assert.equal(out.codex.code, "not_found");
  assert.match(out.codex.error, /not found/);
  assert.equal(out.login.status, "skipped");
  assert.equal(out.login.reason, "codex_not_found");
});

test("doctor reports a failed login probe without failing the call", async () => {
  const out = await runDoctor(
    options({
      execFileImpl: async () => {
        const err = new Error("exited");
        err.code = 1;
        err.stdout = "";
        err.stderr = "Not logged in";
        throw err;
      },
    })
  );

  assert.equal(out.login.status, "failed");
  assert.equal(out.login.exitCode, 1);
  assert.equal(out.login.detail, "Not logged in");
});

test("doctor files resolver notes away from warnings, and reports the recursion guard", async () => {
  const out = await runDoctor(
    options({
      resolve: () => ({ ...resolved, warnings: ["PATH Codex can degrade workspace-write."] }),
      env: { CODEX_DELEGATE_DEPTH: "1" },
    })
  );

  // The note describes the resolver doing its job and fires on every correctly
  // configured Windows machine; `warnings` has to stay empty when nothing is wrong.
  assert.deepEqual(out.codex.notes, ["PATH Codex can degrade workspace-write."]);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.recursionGuard.active, true);
  assert.equal(out.recursionGuard.depth, "1");
});

test("doctor reports no sandbox section, and the old env var says nothing", async () => {
  const win = await runDoctor(options({ platform: "win32" }));
  assert.equal(win.sandbox, undefined);
  assert.deepEqual(win.warnings, []);

  const stale = await runDoctor(
    options({ platform: "win32", env: { CODEX_DELEGATE_WINDOWS_SANDBOX: "elevated" } })
  );
  assert.equal(stale.sandbox, undefined);
  assert.deepEqual(stale.warnings, []);

  const linux = await runDoctor(options({ platform: "linux" }));
  assert.equal(linux.sandbox, undefined);
  assert.deepEqual(linux.warnings, []);
});

test("doctor deep probes the exec surfaces it depends on", async () => {
  const seen = [];
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: async (_cmd, args) => {
        seen.push(args.join(" "));
        return { stdout: "--json --output-last-message", stderr: "" };
      },
    })
  );

  assert.equal(out.deep.ran, true);
  assert.deepEqual(Object.keys(out.deep.surfaces), ["exec", "exec review", "exec resume"]);
  for (const surface of Object.values(out.deep.surfaces)) {
    assert.equal(surface.ok, true);
    assert.equal(surface.hasJson, true);
    assert.equal(surface.hasOutputLastMessage, true);
  }
  assert.ok(seen.includes("exec review --help"));
});

test("doctor deep is skipped when the CLI did not resolve", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      resolve: () => {
        throw new Error("nope");
      },
    })
  );

  assert.equal(out.deep.ran, false);
  assert.equal(out.deep.reason, "codex_not_found");
});

test("doctor tolerates a client that cannot report itself", async () => {
  const out = await runDoctor(
    options({
      getClientInfo: () => {
        throw new Error("no client");
      },
    })
  );

  assert.equal(out.client.name, null);
  assert.deepEqual(out.client.capabilities, {});
});
