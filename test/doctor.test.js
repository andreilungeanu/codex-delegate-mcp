import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/doctor.js";
import { DEFAULT_MODEL } from "../src/command.js";
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
      resolve: () => ({ ...resolved, warnings: ["Preferring the standalone Codex binary on Windows."] }),
      env: { CODEX_DELEGATE_DEPTH: "1" },
    })
  );

  // The note describes the resolver doing its job, and fires on an ordinary
  // Windows setup; `warnings` has to stay empty when nothing is wrong.
  assert.deepEqual(out.codex.notes, ["Preferring the standalone Codex binary on Windows."]);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.recursionGuard.active, true);
  assert.equal(out.recursionGuard.depth, "1");
});

test("doctor deep probes the exec surfaces it depends on", async () => {
  const seen = [];
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: async (_cmd, args) => {
        seen.push(args.join(" "));
        return { stdout: helpFor(args.join(" ")), stderr: "" };
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
  // The shape the bridge is built on: only an initial run can be given --cd.
  assert.equal(out.deep.surfaces.exec.hasCd, true);
  assert.equal(out.deep.surfaces["exec review"].hasCd, false);
  assert.equal(out.deep.surfaces["exec resume"].hasCd, false);
  assert.deepEqual(out.warnings, [], "a CLI matching the assumptions warns about nothing");
  assert.ok(seen.includes("exec review --help"));
});

/** Codex 0.147.0's surfaces, reduced to the flags this check reads. */
function helpFor(invocation, { cdOn = ["exec --help"] } = {}) {
  const cd = cdOn.includes(invocation) ? " -C, --cd <DIR>" : "";
  return `--json --output-last-message${cd}`;
}

test("doctor deep warns when resume gains the --cd it is assumed not to have", async () => {
  // The resume contract exists because `exec resume` cannot be told a directory:
  // the turn runs wherever the child was spawned, so the caller must name the
  // workspace. If upstream adds the flag, that reasoning needs revisiting — and
  // nothing else in this bridge would notice.
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: async (_cmd, args) => ({
        stdout: helpFor(args.join(" "), { cdOn: ["exec --help", "exec resume --help"] }),
        stderr: "",
      }),
    })
  );

  assert.equal(out.deep.surfaces["exec resume"].hasCd, true);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /codex exec resume` now accepts --cd/);
});

test("doctor deep warns when exec loses the --cd initial runs depend on", async () => {
  // The other direction: initial runs pass --cd to set the working root. The child
  // is spawned in the workspace too (delegate.js), so losing the flag would not move
  // the directory — it would make every delegation die on an unknown argument.
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: async (_cmd, args) => ({
        stdout: helpFor(args.join(" "), { cdOn: [] }),
        stderr: "",
      }),
    })
  );

  assert.equal(out.deep.surfaces.exec.hasCd, false);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /codex exec` no longer accepts --cd/);
});

test("a help probe that failed does not masquerade as a --cd change", async () => {
  // A non-zero help call reports no flags at all. Reading that as "the flag was
  // removed" would fire the drift warning on every broken install; `ok: false`
  // already says the probe itself did not work.
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: async () => {
        throw Object.assign(new Error("boom"), { code: 1, stdout: "", stderr: "" });
      },
    })
  );

  assert.equal(out.deep.surfaces.exec.ok, false);
  assert.deepEqual(
    out.warnings.filter((w) => w.includes("--cd")),
    []
  );
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

/** `codex debug models`, reduced to the fields the catalog check reads. */
function catalogJson(models) {
  return JSON.stringify({
    models: models.map((model) => ({
      slug: model.slug,
      visibility: model.visibility ?? "list",
      supported_reasoning_levels: (model.efforts || []).map((effort) => ({ effort })),
    })),
  });
}

function deepExec({ catalog, onDebug } = {}) {
  return async (_cmd, args) => {
    const invocation = args.join(" ");
    if (invocation !== "debug models") return { stdout: helpFor(invocation), stderr: "" };
    if (onDebug) return onDebug();
    return { stdout: catalog, stderr: "" };
  };
}

test("doctor deep reports the catalog and the levels each model takes", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson([
          { slug: DEFAULT_MODEL, efforts: ["low", "high", "max", "ultra"] },
          { slug: "gpt-5.4", efforts: ["low", "high"] },
          { slug: "codex-auto-review", visibility: "hide", efforts: ["low"] },
        ]),
      }),
    })
  );

  assert.equal(out.deep.models.ran, true);
  assert.deepEqual(
    out.deep.models.models.map((model) => model.slug),
    [DEFAULT_MODEL, "gpt-5.4"],
    "a model the CLI hides is not one a caller can ask for"
  );
  assert.deepEqual(out.deep.models.defaultModel, { slug: DEFAULT_MODEL, inCatalog: true });
  // none and minimal are missing from the real catalog and the models still take them,
  // so a level this bridge allows and the catalog omits is not drift.
  assert.deepEqual(out.warnings, []);
});

test("doctor deep warns about a reasoning level the enum cannot request", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson([{ slug: DEFAULT_MODEL, efforts: ["high", "hyper"] }]),
      }),
    })
  );

  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /rejects \(hyper\)/);
});

test("doctor deep warns when the default model is gone from the catalog", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({ catalog: catalogJson([{ slug: "gpt-9-renamed", efforts: ["high"] }]) }),
    })
  );

  assert.equal(out.deep.models.defaultModel.inCatalog, false);
  assert.ok(
    out.warnings.join(" ").includes(`The default model ${DEFAULT_MODEL} is not in the catalog`),
    "a default nothing answers to fails every delegation that omits model"
  );
});

test("a catalog probe that fails leaves the rest of doctor standing", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        onDebug: () => {
          const err = new Error("unrecognized subcommand 'debug'");
          err.code = 2;
          throw err;
        },
      }),
    })
  );

  assert.deepEqual(out.deep.models, { ran: false, reason: "probe_failed", exitCode: 2 });
  assert.equal(out.deep.surfaces.exec.ok, true, "the help probes still ran");
  assert.deepEqual(out.warnings, [], "a surface this cannot read reports nothing, it does not guess");
});
