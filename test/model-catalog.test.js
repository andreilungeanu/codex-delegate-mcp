import { test } from "node:test";
import assert from "node:assert/strict";
import { readModelCatalog, catalogSlugs, listedSlugs } from "../src/model-catalog.js";

const CATALOG = JSON.stringify({
  models: [
    { slug: "gpt-5.6-terra", visibility: "list" },
    { slug: "codex-auto-review", visibility: "hide" },
  ],
});

test("the catalog is read from the CLI, hidden models included", async () => {
  let seen = null;
  const models = await readModelCatalog({
    command: "/bin/codex",
    execFileImpl: async (command, args, options) => {
      seen = { command, args, options };
      return { stdout: CATALOG, stderr: "" };
    },
  });

  assert.deepEqual(seen.args, ["debug", "models"]);
  // --bundled answers differently — it hides gpt-5.4 and lists a gpt-5.2 the live dump
  // does not have — so a model refused on its word would be one the CLI would have run.
  assert.ok(!seen.args.includes("--bundled"));
  assert.equal(seen.options.shell, false);
  assert.deepEqual(catalogSlugs(models), ["gpt-5.6-terra", "codex-auto-review"]);
  assert.deepEqual(listedSlugs(models), ["gpt-5.6-terra"]);
});

test("output that is not JSON reads as no catalog, not as a crash", async () => {
  // The probe failing is covered elsewhere; this is the CLI succeeding and printing
  // something else — a banner, a prompt, a future format. Callers fail open on null, so
  // a throw here would turn a cosmetic CLI change into a bridge that refuses every model.
  const models = await readModelCatalog({
    command: "/bin/codex",
    execFileImpl: async () => ({ stdout: "codex 0.148.0\nnot json at all", stderr: "" }),
  });

  assert.equal(models, null);
});

test("JSON without a models array reads as no catalog", async () => {
  const models = await readModelCatalog({
    command: "/bin/codex",
    execFileImpl: async () => ({ stdout: JSON.stringify({ error: "unsupported" }), stderr: "" }),
  });

  assert.equal(models, null);
});

test("a probe that cannot run reads as no catalog", async () => {
  const models = await readModelCatalog({
    command: "/bin/codex",
    execFileImpl: async () => {
      const err = /** @type {Error & { code?: number }} */ (new Error("unrecognized subcommand"));
      err.code = 2;
      throw err;
    },
  });

  assert.equal(models, null);
});

test("no CLI means no spawn attempt", async () => {
  let spawned = false;
  const models = await readModelCatalog({
    command: null,
    execFileImpl: async () => {
      spawned = true;
      return { stdout: CATALOG, stderr: "" };
    },
  });

  assert.equal(models, null);
  assert.equal(spawned, false);
});
