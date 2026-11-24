import { test } from "node:test";
import assert from "node:assert/strict";
import { readModelCatalog, catalogSlugs, listedSlugs, modelEfforts, listedEfforts } from "../src/model-catalog.js";

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

test("each model's levels, and the union the listed models take", () => {
  const levels = (...efforts) => efforts.map((effort) => ({ effort }));
  const models = [
    { slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: levels("low", "xhigh", "max", "ultra") },
    { slug: "gpt-5.5", visibility: "list", supported_reasoning_levels: levels("low", "xhigh") },
    { slug: "codex-auto-review", visibility: "hide", supported_reasoning_levels: levels("low", "secret") },
    { slug: "gpt-9-bare", visibility: "list" },
    { slug: "gpt-9-empty", visibility: "list", supported_reasoning_levels: [] },
  ];

  assert.deepEqual(modelEfforts(models, "gpt-5.5"), ["low", "xhigh"]);
  // Hidden models are still answered for: they run when named.
  assert.deepEqual(modelEfforts(models, "codex-auto-review"), ["low", "secret"]);
  // No entry, no list and an empty list all mean "the catalog does not say".
  assert.equal(modelEfforts(models, "gpt-9-missing"), null);
  assert.equal(modelEfforts(models, "gpt-9-bare"), null);
  assert.equal(modelEfforts(models, "gpt-9-empty"), null);
  assert.equal(modelEfforts(null, "gpt-5.5"), null);

  // The union offered to callers leaves out what only a hidden model takes.
  assert.deepEqual(listedEfforts(models), ["low", "xhigh", "max", "ultra"]);
  assert.deepEqual(listedEfforts(null), []);
});

test("the union stays lowest first when a model earlier in the catalog skips a level", () => {
  const levels = (...efforts) => efforts.map((effort) => ({ effort }));
  const models = [
    { slug: "gpt-a", visibility: "list", supported_reasoning_levels: levels("low", "high") },
    { slug: "gpt-b", visibility: "list", supported_reasoning_levels: levels("low", "medium", "high", "max") },
  ];

  assert.deepEqual(listedEfforts(models), ["low", "medium", "high", "max"]);
});

test("partial lists preserve shared ordering even when no model lists every level", () => {
  const levels = (...efforts) => efforts.map((effort) => ({ effort }));
  const models = [
    { slug: "gpt-a", visibility: "list", supported_reasoning_levels: levels("low", "xhigh", "max") },
    { slug: "gpt-b", visibility: "list", supported_reasoning_levels: levels("low", "medium", "high", "xhigh") },
  ];
  for (const catalog of [models, [...models].reverse()]) {
    assert.deepEqual(listedEfforts(catalog), ["low", "medium", "high", "xhigh", "max"]);
  }
});

test("contradictory catalog ordering still produces each advertised level once", () => {
  const levels = (...efforts) => efforts.map((effort) => ({ effort }));
  const models = [
    { slug: "gpt-a", visibility: "list", supported_reasoning_levels: levels("low", "high", "max") },
    { slug: "gpt-b", visibility: "list", supported_reasoning_levels: levels("low", "max", "high") },
  ];
  assert.deepEqual(listedEfforts(models), ["low", "high", "max"]);
});

test("a partly malformed reasoning list is unknown, not evidence that a level is absent", () => {
  for (const malformed of [null, {}, { effort: 64 }, { effort: "" }, { effort: "   " }]) {
    const models = [{
      slug: "partial-model",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low" }, malformed],
    }];
    assert.equal(modelEfforts(models, "partial-model"), null);
    assert.deepEqual(listedEfforts(models), []);
  }
});
