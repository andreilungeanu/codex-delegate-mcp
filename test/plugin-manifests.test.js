import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
const pkg = read("package.json");
const pin = `codex-delegate-mcp@${pkg.version}`;
const pluginName = "codex-delegate";
const serverName = "codex-delegate";
const marketplaceName = "codex-delegate-mcp";

test("logo assets exist as PNGs", () => {
  // logo-400.png is the square size marketplace submissions ask for.
  for (const rel of ["assets/logo-light.png", "assets/logo-dark.png", "assets/logo-400.png"]) {
    const target = resolve(ROOT, rel);
    assert.ok(existsSync(target), `${rel} must exist`);
    assert.deepEqual([...readFileSync(target).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
});

test("marketplaces and Copilot plugin point at the intended package", () => {
  const copilot = read("plugin.json");
  assert.equal(copilot.name, pluginName);
  assert.ok(existsSync(resolve(ROOT, copilot.skills)));
  assert.ok(existsSync(resolve(ROOT, copilot.mcpServers)));
  const copilotMcp = read(".mcp.copilot.json");
  assert.deepEqual(copilotMcp[serverName].args, ["-y", pin]);

  const copilotMarketplace = read(".github/plugin/marketplace.json");
  assert.equal(copilotMarketplace.name, marketplaceName);
  assert.equal(copilotMarketplace.plugins[0].source, "./");
  assert.equal(copilotMarketplace.plugins[0].name, pluginName);
  assert.equal(copilotMarketplace.plugins[0].name, copilot.name);
});

test("Claude plugin launches bundled code and bootstraps its runtime dependencies", () => {
  const manifest = read(".claude-plugin/plugin.json");
  const marketplace = read(".claude-plugin/marketplace.json");
  assert.equal(manifest.name, pluginName);
  assert.equal(marketplace.name, marketplaceName);
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.notEqual(marketplace.plugins[0].name, marketplace.name);
  assert.equal(manifest.mcpServers, "./.claude-plugin/mcp.json");
  assert.equal(manifest.hooks, "./.claude-plugin/hooks.json");

  const claudeMcp = read(".claude-plugin/mcp.json");
  const server = claudeMcp.mcpServers[serverName];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/server.js"]);

  // Claude Code migrates an existing install through this map; a target that is not a
  // listed plugin resolves to plugin-not-found instead.
  const listed = new Set(marketplace.plugins.map((entry) => entry.name));
  for (const [from, to] of Object.entries(marketplace.renames)) {
    assert.ok(!listed.has(from), `renamed-from ${from} must not still be a plugin entry`);
    assert.ok(to === null || listed.has(to), `rename ${from} must terminate at null or a listed plugin`);
  }
  assert.equal(marketplace.renames["codex-delegate-mcp"], pluginName);

  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  assert.match(readme, new RegExp(`/plugin install ${pluginName}@${marketplaceName}`));

  const hooks = read(".claude-plugin/hooks.json");
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /\.claude-plugin\/ensure-deps\.mjs/);
  assert.ok(existsSync(resolve(ROOT, ".claude-plugin/ensure-deps.mjs")));
});

test("Codex plugin manifest pins the package and points at assets that exist", () => {
  const manifest = read(".codex-plugin/plugin.json");
  assert.equal(manifest.name, pluginName);
  assert.deepEqual(manifest.mcpServers[serverName].args, ["-y", pin]);
  assert.ok(existsSync(resolve(ROOT, manifest.skills)));

  // Codex rejects a listing whose short description, support URL or brand colour is
  // missing, and a manifest that points at an asset the repo does not ship.
  const ui = manifest.interface;
  assert.ok(ui.shortDescription && ui.shortDescription.length <= 40);
  assert.match(ui.supportURL, /^https:\/\//);
  assert.match(ui.brandColor, /^#[0-9A-Fa-f]{6}$/);
  for (const rel of [ui.logo, ui.composerIcon, ...(ui.screenshots || [])]) {
    assert.ok(existsSync(resolve(ROOT, rel)), `${rel} must exist`);
  }
});

test("no host auto-discovery leak configs at conventional paths", () => {
  assert.ok(!existsSync(resolve(ROOT, ".mcp.json")), ".mcp.json at the repo root leaks into Copilot installs");
  assert.ok(!existsSync(resolve(ROOT, "hooks/hooks.json")), "hooks/hooks.json is auto-discovered by some hosts");
  assert.ok(!existsSync(resolve(ROOT, ".agents/plugins")), "Codex marketplace packaging is not used");
});

// The probe carries the real dependency names so the sentinel is exercised on the
// paths it ships against, and resolves them from local directories so the install is
// offline and fast. An empty dependency set cannot tell a working hook from one that
// exits 0 having installed nothing — npm writes a lockfile either way.
const FIXTURES = { "@modelcontextprotocol/sdk": "sdk", zod: "zod" };

const buildProbe = async (prepare) => {
  const root = await mkdtemp(join(tmpdir(), "cdm-plugin-"));
  await mkdir(join(root, ".claude-plugin"));
  await cp(resolve(ROOT, ".claude-plugin/ensure-deps.mjs"), join(root, ".claude-plugin/ensure-deps.mjs"));

  const dependencies = {};
  for (const [name, dir] of Object.entries(FIXTURES)) {
    await mkdir(join(root, "fixtures", dir), { recursive: true });
    await writeFile(join(root, "fixtures", dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }), "utf8");
    dependencies[name] = `file:./fixtures/${dir}`;
  }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "cdm-plugin-probe", version: "1.0.0", private: true, dependencies }),
    "utf8"
  );

  if (prepare) await prepare(root);
  return root;
};

const runHook = (root) =>
  promisify(execFile)(process.execPath, [join(root, ".claude-plugin", "ensure-deps.mjs")], { timeout: 120_000 });

// npm writes a lockfile when it runs, so its absence is the observable proof the hook
// skipped and its presence the proof it did not.
const installRan = (root) => existsSync(join(root, "package-lock.json"));
const importable = (root, name) => existsSync(join(root, "node_modules", name, "package.json"));
const placeDep = async (root, name, complete) => {
  await mkdir(join(root, "node_modules", name), { recursive: true });
  if (complete) await writeFile(join(root, "node_modules", name, "package.json"), JSON.stringify({ name }), "utf8");
};

test("the SessionStart hook can spawn npm on this platform", async () => {
  // npm.cmd is a batch file, and Node refuses to spawn one without a shell — the
  // failure is `spawnSync npm.cmd EINVAL` on the first session after a plugin
  // install, before doctor exists to report it. Only a real spawn catches that, so
  // this runs the hook rather than asserting on the source.
  const root = await buildProbe();
  const { stdout } = await runHook(root);

  assert.doesNotMatch(stdout, /dependency install failed/);
  for (const name of Object.keys(FIXTURES)) {
    assert.ok(importable(root, name), `${name} must be installed once the hook returns`);
  }
});

test("the dependency sentinel repairs every incomplete install", async () => {
  // A half-finished install leaves directories behind. Skipping on their bare
  // existence keeps the plugin broken on every later session, with the server still
  // failing to import. Asserted by running the hook rather than by reading it: the
  // source can name a path in a comment and still skip wrong.
  const complete = await buildProbe(async (root) => {
    for (const name of Object.keys(FIXTURES)) await placeDep(root, name, true);
  });
  await runHook(complete);
  assert.ok(!installRan(complete), "a complete install must be left alone");

  const bare = await buildProbe(async (root) => {
    await mkdir(join(root, "node_modules"), { recursive: true });
  });
  await runHook(bare);
  assert.ok(installRan(bare), "an empty node_modules must still install");

  // The SDK is only one of the dependencies the server imports; an install that dies
  // after it and before zod satisfies a check that names the SDK alone.
  const partialTree = await buildProbe(async (root) => {
    await placeDep(root, "@modelcontextprotocol/sdk", true);
  });
  await runHook(partialTree);
  assert.ok(installRan(partialTree), "a dependency missing beside the SDK must still install");
  assert.ok(importable(partialTree, "zod"), "the repair must land the missing dependency");

  // npm extracts into the package directory, so an interrupted unpack leaves the
  // directory present and its package.json absent.
  const partialPackage = await buildProbe(async (root) => {
    await placeDep(root, "@modelcontextprotocol/sdk", false);
    await placeDep(root, "zod", true);
  });
  await runHook(partialPackage);
  assert.ok(installRan(partialPackage), "a half-extracted dependency must still install");
  assert.ok(importable(partialPackage, "@modelcontextprotocol/sdk"), "the repair must complete the extraction");
});
