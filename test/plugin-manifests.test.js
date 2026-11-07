import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "./fixtures/temp-dir.mjs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_HARD_CAP_MS } from "../src/run-codex.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
const pkg = read("package.json");
const pin = `codex-delegate-mcp@${pkg.version}`;
// Copilot and Antigravity install this whole repository as the plugin and spawn its server
// there. `npx -y <pin>` in that folder matches the pin to this package.json, finds no
// node_modules/.bin, and the server never starts. An npm alias spec has no package name, so npx
// skips the local match and fetches the exact pinned version.
const npxPin = `npm:${pin}`;
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
  const copilot = read(".github/plugin/plugin.json");
  assert.equal(copilot.name, pluginName);
  assert.ok(existsSync(resolve(ROOT, copilot.skills)));
  assert.ok(existsSync(resolve(ROOT, copilot.mcpServers)));
  const copilotMcp = read(".mcp.copilot.json");
  assert.deepEqual(copilotMcp[serverName].args, ["-y", npxPin]);

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

test("Cursor plugin launches the published package and points at a committed logo", () => {
  // Cursor runs no SessionStart hook, so a plugin cache it clones never gets the
  // dependency install the Claude manifest relies on: `node src/server.js` there dies
  // on `Cannot find package '@modelcontextprotocol/sdk'`. npx carries its own tree.
  const manifest = read(".cursor-plugin/plugin.json");
  assert.equal(manifest.name, pluginName);
  const server = manifest.mcpServers[serverName];
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", npxPin]);
  assert.ok(existsSync(resolve(ROOT, manifest.skills)));

  // A relative logo resolves against raw.githubusercontent.com, so the file has to be
  // committed under that path or the listing falls back to a generic icon.
  assert.ok(!manifest.logo.startsWith("./"), "a raw.githubusercontent path takes no ./ prefix");
  assert.ok(existsSync(resolve(ROOT, manifest.logo)), `${manifest.logo} must exist`);
});

test("Antigravity plugin manifest and MCP config reference real files and outlast the bridge hard cap", () => {
  const manifest = read(".antigravity-plugin/plugin.json");
  assert.equal(manifest.name, pluginName);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  // The marketplace asks for a square logo of at least 128 px; IHDR holds width and height.
  const logo = readFileSync(resolve(ROOT, manifest.logo));
  assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(logo.readUInt32BE(16), logo.readUInt32BE(20), "logo must be 1:1");
  assert.ok(logo.readUInt32BE(16) >= 128, "logo must be at least 128 px");
  assert.ok(existsSync(resolve(ROOT, "skills")), "default skills/ directory must exist");

  const config = read("mcp_config.json");
  assert.deepEqual(Object.keys(config), ["mcpServers"]);
  const server = config.mcpServers[serverName];
  assert.ok(server, `mcp_config.json must define the ${serverName} server`);
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", npxPin]);
  // Antigravity ends a tool call after 180 s unless the server entry sets timeoutSeconds, and
  // progress notifications do not extend it. The hard-cap timer starts after Antigravity's
  // clock, so the margin lets the structured hard-cap error arrive first.
  const timeoutSec = server.timeoutSeconds;
  // The schema types timeoutSeconds as an integer; a quoted value would pass the comparison
  // below by coercion.
  assert.ok(Number.isInteger(timeoutSec), "Antigravity timeoutSeconds must be a JSON integer");
  assert.ok(
    timeoutSec * 1000 >= DEFAULT_HARD_CAP_MS + 60000,
    "Antigravity timeoutSeconds must exceed the bridge hard cap by at least a minute"
  );
});

test("Antigravity plugin manifest uses accepted schema fields", () => {
  // The manifest schema sets additionalProperties: false and has no mcpServers field; servers
  // live in mcp_config.json. Keep this contract in npm test so CI catches it without the
  // Antigravity CLI installed.
  // https://antigravity.google/docs/build-plugins
  const allowed = new Set([
    "$schema", "name", "displayName", "description", "version", "disabled", "logo",
    "suggestedPrompts", "skills", "author", "homepage", "repository", "license", "keywords",
    "extensions",
  ]);
  const manifest = read(".antigravity-plugin/plugin.json");
  assert.deepEqual(Object.keys(manifest).filter((key) => !allowed.has(key)), [], "unsupported manifest keys");
  assert.deepEqual(Object.keys(manifest.author).filter((key) => !["name", "email", "url"].includes(key)), []);
  assert.ok(manifest.suggestedPrompts.length <= 3, "suggestedPrompts holds at most 3 entries");
  assert.ok(
    manifest.description.length >= 120 && manifest.description.length <= 160,
    "marketplace listings take a description of 120-160 characters"
  );

  // Marketplace submission requires `agy plugin validate --strict` to pass and a name and
  // displayName that do not lead with "Antigravity", "Gemini", "Claude", or "Cursor".
  for (const value of [manifest.name, manifest.displayName]) {
    assert.doesNotMatch(value, /^(antigravity|gemini|claude|cursor)/i, `${value} leads with a reserved name`);
  }
});

test("no command shares a skill's name", () => {
  // Claude Code lists both as /codex-delegate:<name> and loads the command, so the
  // skill's workflow never reaches the caller.
  for (const name of readdirSync(resolve(ROOT, "skills"))) {
    assert.ok(!existsSync(resolve(ROOT, "commands", `${name}.md`)), `commands/${name}.md hides skills/${name}`);
  }
});

test("no host auto-discovery leak configs at conventional paths", () => {
  assert.ok(!existsSync(resolve(ROOT, ".mcp.json")), ".mcp.json at the repo root leaks into Copilot installs");
  assert.ok(!existsSync(resolve(ROOT, "hooks/hooks.json")), "hooks/hooks.json is auto-discovered by some hosts");
  assert.ok(!existsSync(resolve(ROOT, ".agents/plugins")), "Codex marketplace packaging is not used");
  // Antigravity reads a root plugin.json as a second manifest, and `agy plugin validate --strict` fails on it.
  assert.ok(!existsSync(resolve(ROOT, "plugin.json")), "Copilot's manifest belongs in .github/plugin/");
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
