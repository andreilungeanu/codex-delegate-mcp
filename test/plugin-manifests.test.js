import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("the SessionStart hook can spawn npm on this platform", async () => {
  const { mkdtemp, mkdir, writeFile, cp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { join } = await import("node:path");

  // npm.cmd is a batch file, and Node refuses to spawn one without a shell — the
  // failure is `spawnSync npm.cmd EINVAL` on the first session after a plugin
  // install, before doctor exists to report it. Only a real spawn catches that, so
  // this runs the hook against an empty dependency set rather than asserting on the
  // source.
  const root = await mkdtemp(join(tmpdir(), "cdm-plugin-"));
  await mkdir(join(root, ".claude-plugin"));
  await cp(resolve(ROOT, ".claude-plugin/ensure-deps.mjs"), join(root, ".claude-plugin/ensure-deps.mjs"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "cdm-plugin-probe", version: "1.0.0", private: true, dependencies: {} }),
    "utf8"
  );

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(root, ".claude-plugin", "ensure-deps.mjs")],
    { timeout: 120_000 }
  );
  assert.doesNotMatch(stdout, /dependency install failed/);
});

test("the dependency sentinel checks the SDK, not a bare node_modules", async () => {
  const { mkdtemp, mkdir, writeFile, cp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { join } = await import("node:path");

  // A half-finished install leaves node_modules behind. Skipping on its bare
  // existence would keep the plugin broken on every later session, with the server
  // still failing to import the SDK. Asserted by running the hook rather than by
  // reading it: the source can name the SDK path in a comment and still skip wrong.
  const build = async (sdkPresent) => {
    const root = await mkdtemp(join(tmpdir(), "cdm-sentinel-"));
    await mkdir(join(root, ".claude-plugin"));
    await cp(
      resolve(ROOT, ".claude-plugin/ensure-deps.mjs"),
      join(root, ".claude-plugin/ensure-deps.mjs")
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "cdm-sentinel", version: "1.0.0", private: true, dependencies: {} }),
      "utf8"
    );
    const sdk = join(root, "node_modules", "@modelcontextprotocol", "sdk");
    await mkdir(sdkPresent ? sdk : join(root, "node_modules"), { recursive: true });
    await promisify(execFile)(process.execPath, [join(root, ".claude-plugin", "ensure-deps.mjs")], {
      timeout: 120_000,
    });
    return root;
  };

  // npm writes a lockfile when it runs, so its absence is the observable proof the
  // hook skipped and its presence the proof it did not.
  assert.ok(
    !existsSync(join(await build(true), "package-lock.json")),
    "an installed SDK must skip the install"
  );
  assert.ok(
    existsSync(join(await build(false), "package-lock.json")),
    "a node_modules without the SDK must still install"
  );
});
