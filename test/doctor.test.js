import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/doctor.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "../src/command.js";
import { VERSION } from "../src/version.js";

// Codex's help surfaces, reduced to the flags doctor reads.
const HELP = "--json --output-last-message";

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
    execFileImpl: async () => ({ stdout: "Logged in using ChatGPT", stderr: "" }),
    readUsage: async () => null,
    ...overrides,
  };
}

test("doctor reports a resolved CLI, login and workspace, and no section it has nothing for", async () => {
  const out = await runDoctor(options());

  assert.deepEqual(out.plugin, { name: "codex-delegate-mcp", version: VERSION });
  assert.equal(out.agent.found, true);
  assert.equal(out.agent.command, "/bin/codex");
  assert.equal(out.agent.version, "0.145.0");
  assert.deepEqual(out.auth, { status: "ok", method: "chatgpt" });
  assert.equal(out.workspace.path, process.cwd());
  assert.equal(out.workspace.exists, true);
  assert.equal(out.workspace.isGitRepo, true);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(Object.keys(out), ["plugin", "client", "agent", "auth", "workspace", "warnings"]);
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

  assert.equal(out.agent.found, false);
  assert.equal(out.agent.code, "not_found");
  assert.match(out.agent.error, /not found/);
  assert.deepEqual(out.auth, { status: "unknown" });
  assert.match(out.warnings.join("\n"), /Codex CLI not found/);
});

test("doctor keeps the resolver's notes even when resolution failed", async () => {
  // The notes are the diagnosis: on the machine that fails to resolve, the shim
  // warning is the one line that says what to fix. Dropping them because the
  // resolution itself failed reports "not found" with nothing to act on.
  const out = await runDoctor(
    options({
      resolve: () => {
        const err = new Error("Codex CLI not found.");
        err.code = "not_found";
        err.details = { warnings: ["Codex on PATH is a .cmd shim that cannot be spawned directly."] };
        throw err;
      },
    })
  );

  assert.equal(out.agent.found, false);
  assert.deepEqual(out.agent.notes, [
    "Codex on PATH is a .cmd shim that cannot be spawned directly.",
  ]);
});

test("a non-zero exit from login status reads as logged out, with what to run", async () => {
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

  assert.deepEqual(out.auth, { status: "logged-out", detail: "Not logged in" });
  assert.ok(out.warnings.includes("Codex is not logged in. Run `codex login`."));
});

test("a login probe that never answers is unknown, not logged out", async () => {
  const out = await runDoctor(
    options({
      execFileImpl: async () => {
        const err = new Error("spawn codex ETIMEDOUT");
        err.code = "ETIMEDOUT";
        throw err;
      },
    })
  );

  assert.equal(out.auth.status, "unknown");
  assert.deepEqual(out.warnings, []);
});

test("an API-key login is named as one", async () => {
  const out = await runDoctor(options({ execFileImpl: async () => ({ stdout: "Logged in using an API key - sk-proj-***", stderr: "" }) }));
  assert.deepEqual(out.auth, { status: "ok", method: "api-key" });
});

test("doctor leaves out a resolved CLI's notes, and reports the recursion guard and env knobs only when set", async () => {
  const out = await runDoctor(
    options({
      resolve: () => ({ ...resolved, warnings: ["Preferring the standalone Codex binary on Windows."] }),
      env: { CODEX_DELEGATE_DEPTH: "1", CODEX_DELEGATE_STARTUP_MS: "90000", UNRELATED: "x" },
    })
  );

  // The note fires on every ordinary Windows setup.
  assert.equal("notes" in out.agent, false);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.recursionGuard, { depth: "1" });
  assert.deepEqual(out.env, { CODEX_DELEGATE_STARTUP_MS: "90000" });

  const quiet = await runDoctor(options());
  assert.equal("recursionGuard" in quiet, false);
  assert.equal("env" in quiet, false);
});

test("doctor deep probes the exec surfaces it depends on", async () => {
  const seen = [];
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: async (_cmd, args) => {
        seen.push(args.join(" "));
        return { stdout: HELP, stderr: "" };
      },
    })
  );

  assert.deepEqual(out.warnings, [], "a CLI matching the assumptions warns about nothing");
  for (const surface of ["exec", "exec review", "exec resume"]) assert.ok(seen.includes(`${surface} --help`));
});

test("a help surface that fails or drops a flag delegation passes is a warning", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: async (_cmd, args) => {
        const call = args.join(" ");
        if (call === "exec review --help") {
          const err = new Error("exited");
          err.code = 2;
          throw err;
        }
        if (call === "exec resume --help") return { stdout: "--json", stderr: "" };
        return { stdout: HELP, stderr: "" };
      },
    })
  );

  assert.deepEqual(out.warnings, [
    "`codex exec review --help` failed (exit 2); delegation runs through it.",
    "`codex exec resume --help` does not list --output-last-message, which delegation passes.",
  ]);
});

test("doctor runs login, help and catalog probes through a resolved launcher script", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-doctor-launcher-"));
  try {
    const script = path.join(dir, "codex.js");
    await writeFile(
      script,
      [
        "const call = process.argv.slice(2).join(' ');",
        "if (call === 'login status') console.log('Logged in using ChatGPT');",
        "else if (call.endsWith('--help')) console.log(call === 'exec --help' ? '--json --output-last-message -C, --cd <DIR>' : '--json --output-last-message');",
        `else if (call === 'debug models') console.log(JSON.stringify({ models: [{ slug: ${JSON.stringify(DEFAULT_MODEL)}, visibility: 'list', supported_reasoning_levels: [{ effort: ${JSON.stringify(DEFAULT_REASONING_EFFORT)} }] }] }));`,
        "else process.exit(9);",
      ].join("\n"),
      "utf8"
    );
    const out = await runDoctor({
      workspace: process.cwd(),
      env: {},
      deep: true,
      readUsage: async () => null,
      resolve: () => ({ command: process.execPath, commandArgs: [script], source: "path", version: "0.171.0", warnings: [] }),
    });
    assert.deepEqual(out.agent.commandArgs, [script]);
    assert.deepEqual(out.auth, { status: "ok", method: "chatgpt" });
    assert.deepEqual(out.warnings, []);
    assert.equal(out.models.defaultAvailable, true, JSON.stringify(out.models));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor deep probes nothing when the CLI did not resolve", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      resolve: () => {
        throw new Error("nope");
      },
    })
  );

  assert.equal("models" in out, false);
  assert.equal("usage" in out, false);
});

test("doctor tolerates a client that cannot report itself", async () => {
  const out = await runDoctor(
    options({
      getClientInfo: () => {
        throw new Error("no client");
      },
    })
  );

  assert.deepEqual(out.client, { name: null, version: null });
});

test("doctor reports the host's protocol revision, and leaves it out when the host named none", async () => {
  const named = await runDoctor(options({ getClientInfo: () => ({ capabilities: {}, version: {}, protocolVersion: "2026-07-28" }) }));
  assert.equal(named.client.protocolVersion, "2026-07-28");
  const unnamed = await runDoctor(options({ getClientInfo: () => ({ capabilities: {}, version: {} }) }));
  assert.equal("protocolVersion" in unnamed.client, false);
});

/** Listed slugs for the catalogs below, default first. */
const MODELS = [DEFAULT_MODEL, "gpt-6-sol", "gpt-5.5"];

/** `codex debug models`, reduced to the fields the catalog check reads. */
function catalogJson(models) {
  return JSON.stringify({
    models: models.map((model) => ({
      slug: model.slug,
      visibility: model.visibility ?? "list",
      supported_reasoning_levels: (model.efforts || []).map((effort) => ({ effort })),
      // The real catalog carries null until a retirement is scheduled.
      upgrade: model.upgrade ?? null,
    })),
  });
}

function deepExec({ catalog, onDebug } = {}) {
  return async (_cmd, args) => {
    const invocation = args.join(" ");
    if (invocation !== "debug models") return { stdout: HELP, stderr: "" };
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
          ...MODELS.map((slug) => ({ slug, efforts: ["low", "high", "xhigh", "max", "ultra"] })),
          { slug: "codex-auto-review", visibility: "hide", efforts: ["low"] },
        ]),
      }),
    })
  );

  assert.deepEqual(out.models, {
    default: DEFAULT_MODEL,
    defaultAvailable: true,
    // a model the CLI hides is not one a caller can ask for
    available: [...MODELS],
    efforts: ["low", "high", "xhigh", "max", "ultra"],
  });
  assert.deepEqual(out.warnings, []);
});

test("doctor deep states the common level list once and names only the models that differ", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson([
          { slug: "gpt-6-sol", efforts: ["low", "high", "ultra"] },
          { slug: DEFAULT_MODEL, efforts: ["low", "high"] },
          { slug: "gpt-6-astra", efforts: ["low", "high", "ultra"] },
        ]),
      }),
    })
  );

  assert.deepEqual(out.models.efforts, ["low", "high", "ultra"]);
  assert.deepEqual(out.models.effortsByModel, { [DEFAULT_MODEL]: ["low", "high"] });
});

test("a level the catalog adds is not drift: the field is described from the same catalog", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson(
          MODELS.map((slug) => ({ slug, efforts: ["high", DEFAULT_REASONING_EFFORT, "hyper"] }))
        ),
      }),
    })
  );

  assert.deepEqual(out.warnings, []);
});

test("doctor deep warns when the default model stops listing the default level", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson(
          MODELS.map((slug) => ({
            slug,
            efforts: slug === DEFAULT_MODEL ? ["low", "high"] : ["high", DEFAULT_REASONING_EFFORT],
          }))
        ),
      }),
    })
  );

  assert.equal(out.warnings.length, 1);
  assert.ok(
    out.warnings[0].includes(
      `The default reasoning level ${DEFAULT_REASONING_EFFORT} is not among the levels the catalog lists for ${DEFAULT_MODEL} (low, high)`
    )
  );
  assert.match(out.warnings[0], /is forwarded with a warning, and Codex may normalize or reject it/);
});

test("a default model entry with no levels raises no level warning", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson(MODELS.map((slug) => ({ slug }))),
      }),
    })
  );

  assert.deepEqual(out.warnings, []);
});

test("doctor treats malformed default reasoning lists as unknown", async () => {
  for (const levels of [[{ effort: "low" }, {}], { effort: "low" }]) {
    const out = await runDoctor(options({
      deep: true,
      execFileImpl: deepExec({
        catalog: JSON.stringify({ models: [{ slug: DEFAULT_MODEL, visibility: "list", supported_reasoning_levels: levels }] }),
      }),
    }));
    assert.deepEqual(out.models.efforts, []);
    assert.deepEqual(out.warnings, []);
  }
});

test("doctor deep warns when the default model is gone from the catalog", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson(
          MODELS.filter((slug) => slug !== DEFAULT_MODEL).map((slug) => ({
            slug,
            efforts: ["high"],
          }))
        ),
      }),
    })
  );

  assert.equal(out.models.defaultAvailable, false);
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

  // One shape for a probe that died and one that printed nonsense: neither is readable,
  // and no warning is worth raising off a catalog nobody got.
  assert.deepEqual(out.models, { ran: false, reason: "unreadable" });
  assert.deepEqual(out.warnings, [], "a surface this cannot read reports nothing, it does not guess");
});

test("models the catalog adds, drops or dates for retirement are not drift", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson([
          { slug: DEFAULT_MODEL, efforts: ["high", DEFAULT_REASONING_EFFORT] },
          { slug: "gpt-7-unannounced", efforts: ["high"] },
          {
            slug: "gpt-5.5",
            efforts: ["high"],
            upgrade: { model: "gpt-7-unannounced", retirement_at: "2026-10-14T19:00:00Z", migration_markdown: "…" },
          },
        ]),
      }),
    })
  );

  // The model field is described from this same catalog at startup, so there is no
  // second list for it to disagree with. The date is still reported, just not warned on.
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.models.available, [DEFAULT_MODEL, "gpt-7-unannounced", "gpt-5.5"]);
  assert.deepEqual(out.models.retiring, { "gpt-5.5": "2026-10-14T19:00:00Z" });
});

test("a retiring default is named as the default", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson(
          MODELS.map((slug) => ({
            slug,
            efforts: ["high", DEFAULT_REASONING_EFFORT],
            upgrade: slug === DEFAULT_MODEL ? { model: null, retirement_at: "2027-01-01T00:00:00Z" } : null,
          }))
        ),
      }),
    })
  );

  assert.equal(out.warnings.length, 1);
  assert.ok(out.warnings[0].includes(`The default model ${DEFAULT_MODEL} retires on 2027-01-01T00:00:00Z`));
});

test("a retired default is reported once, by the message that says what it costs", async () => {
  const out = await runDoctor(
    options({
      deep: true,
      execFileImpl: deepExec({
        catalog: catalogJson(
          MODELS.filter((slug) => slug !== DEFAULT_MODEL).map((slug) => ({ slug, efforts: ["high"] }))
        ),
      }),
    })
  );

  // Not twice: the default is the one case where the generic message would say less.
  assert.equal(out.warnings.length, 1);
  assert.ok(out.warnings[0].includes(`The default model ${DEFAULT_MODEL} is not in the catalog`));
});
