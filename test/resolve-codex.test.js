import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  parseVersion,
  compareSemver,
  resolveCodex,
  whichOnPath,
} from "../src/resolve-codex.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { mkdtemp } from "./fixtures/temp-dir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";

test("parseVersion and compareSemver", () => {
  assert.deepEqual(parseVersion("codex-cli 0.144.4"), [0, 144, 4]);
  assert.equal(compareSemver([0, 144, 0], [0, 143, 9]), 1);
  assert.equal(compareSemver([0, 144, 0], [0, 144, 0]), 0);
});

test("resolveCodex uses override and version gate", () => {
  const resolved = resolveCodex({
    env: { CODEX_DELEGATE_COMMAND: process.execPath },
    platform: "linux",
    homeDir: "/nonexistent-home",
    runVersion: () => "codex-cli 0.144.4",
  });
  assert.equal(resolved.source, "override");
  assert.equal(resolved.version, "0.144.4");
});

test("resolveCodex reports the version without gating on it", () => {
  const base = {
    env: { CODEX_DELEGATE_COMMAND: process.execPath },
    platform: "linux",
    homeDir: "/nonexistent-home",
  };

  // An old CLI is the caller's business, not ours to refuse: any floor we set
  // could only mean "older than we happened to test".
  assert.equal(
    resolveCodex({ ...base, runVersion: () => "codex-cli 0.100.0" }).version,
    "0.100.0"
  );

  // An unreadable version does not block resolution either.
  assert.equal(
    resolveCodex({ ...base, runVersion: () => "no version here" }).version,
    null
  );
});

test("resolveCodex rejects relative override", () => {
  assert.throws(
    () =>
      resolveCodex({
        env: { CODEX_DELEGATE_COMMAND: "codex" },
        platform: "linux",
        homeDir: "/nonexistent-home",
        runVersion: () => "codex-cli 0.144.4",
      }),
    (err) => err.code === "override_not_absolute"
  );
});

test("resolveCodex not_found when no candidates", () => {
  assert.throws(
    () =>
      resolveCodex({
        env: { PATH: "", Path: "" },
        platform: "win32",
        homeDir: "D:\\nonexistent-home-no-codex",
        lookupOnPath: () => null,
        runVersion: () => "codex-cli 0.144.4",
      }),
    (err) => err.code === "not_found"
  );
});

test("a standalone releases path that cannot be listed is skipped", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cdm-releases-"));
  const standalone = path.join(home, ".codex", "packages", "standalone");
  await mkdir(standalone, { recursive: true });
  // existsSync is true for a file; readdirSync throws ENOTDIR. The lookup's
  // answer is "no standalone", the same as a missing directory, so the override
  // and PATH still get a turn.
  await writeFile(path.join(standalone, "releases"), "not a directory\n", "utf8");

  try {
    const resolved = resolveCodex({
      env: { CODEX_DELEGATE_COMMAND: process.execPath },
      platform: "linux",
      homeDir: home,
      runVersion: () => "codex-cli 0.144.4",
      lookupOnPath: () => null,
    });
    assert.equal(resolved.source, "override");
    assert.equal(resolved.command, process.execPath);

    assert.throws(
      () =>
        resolveCodex({
          env: { PATH: "", Path: "" },
          platform: "linux",
          homeDir: home,
          lookupOnPath: () => null,
          runVersion: () => "codex-cli 0.144.4",
        }),
      (err) => err.code === "not_found"
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed resolution keeps the resolver's notes", () => {
  // The shape of an npm-only Windows install: the only codex on PATH is a .cmd
  // shim, nothing else resolves, and the resolver refuses. The note that says
  // why is written at the same moment it used to be thrown away.
  try {
    resolveCodex({
      env: { PATH: "", Path: "" },
      platform: "win32",
      homeDir: "D:\\nonexistent-home-no-codex",
      lookupOnPath: () => ({ command: null, unusable: true }),
      runVersion: () => "codex-cli 0.144.4",
    });
    assert.fail("expected not_found");
  } catch (err) {
    assert.equal(err.code, "not_found");
    assert.deepEqual(err.details.warnings, [
      "Codex on PATH is a .cmd shim that cannot be spawned directly; install the standalone Codex or set CODEX_DELEGATE_COMMAND to codex.exe.",
    ]);
  }
});

test("a version-probe failure still carries the resolver's notes", () => {
  try {
    resolveCodex({
      env: { CODEX_DELEGATE_COMMAND: process.execPath },
      platform: "win32",
      homeDir: "D:\\nonexistent-home-no-codex",
      lookupOnPath: () => ({ command: null, unusable: true }),
      runVersion: () => {
        throw new Error("probe exploded");
      },
    });
    assert.fail("expected a throw");
  } catch (err) {
    assert.match(err.message, /probe exploded/);
    assert.deepEqual(err.details.warnings, [
      "Codex on PATH is a .cmd shim that cannot be spawned directly; install the standalone Codex or set CODEX_DELEGATE_COMMAND to codex.exe.",
    ]);
  }
});

test("whichOnPath on Windows skips a .cmd shim in favor of codex.exe", () => {
  const command = whichOnPath("codex", "win32", {}, () => ({
    status: 0,
    stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\r\nC:\\Codex\\codex.EXE\r\n",
  }));

  assert.equal(command, "C:\\Codex\\codex.EXE");
});

test("resolveCodex skips and warns about Windows PATH shims", () => {
  const pathLookup = whichOnPath("codex", "win32", {}, () => ({
    status: 0,
    stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\r\n",
  }));
  assert.deepEqual(pathLookup, { command: null, unusable: true });

  const resolved = resolveCodex({
    env: { CODEX_DELEGATE_COMMAND: process.execPath, PATH: "", Path: "" },
    platform: "win32",
    homeDir: "D:\\nonexistent-home-no-codex",
    lookupOnPath: () => pathLookup,
    runVersion: () => "codex-cli 0.144.4",
  });

  assert.equal(resolved.source, "override");
  assert.deepEqual(resolved.warnings, [
    "Codex on PATH is a .cmd shim that cannot be spawned directly; install the standalone Codex or set CODEX_DELEGATE_COMMAND to codex.exe.",
  ]);
});

// What npm's cmd-shim writes for `npm i -g @openai/codex`: it runs bin/codex.js with node.
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  "",
].join("\r\n");

// What pnpm's @zkochan/cmd-shim writes: the same target, through %~dp0.
const PNPM_SHIM = [
  "@SETLOCAL",
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ") ELSE (",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ")",
  "",
].join("\r\n");

async function shimDir(shim, target, body = "") {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-shim-"));
  const file = path.join(dir, ...target.split("\\"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
  const cmd = path.join(dir, "codex.cmd");
  await writeFile(cmd, shim, "utf8");
  return { dir, cmd, file };
}

const whereFinds = (...lines) => () => ({ status: 0, stdout: lines.join("\r\n") + "\r\n" });

test("whichOnPath runs the script an npm .cmd shim points at with node, since node cannot spawn the .cmd", async () => {
  const { dir, cmd, file } = await shimDir(NPM_SHIM, "node_modules\\@openai\\codex\\bin\\codex.js");
  try {
    assert.deepEqual(whichOnPath("codex", "win32", {}, whereFinds(cmd)), {
      command: process.execPath,
      commandArgs: [file],
      shim: cmd,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("whichOnPath reads a pnpm .cmd shim, and runs an .exe target directly", async () => {
  const pnpm = await shimDir(PNPM_SHIM, "global\\5\\node_modules\\@openai\\codex\\bin\\codex.js");
  const exe = await shimDir(NPM_SHIM.replace("bin\\codex.js", "bin\\codex.exe"), "node_modules\\@openai\\codex\\bin\\codex.exe");
  try {
    assert.deepEqual(whichOnPath("codex", "win32", {}, whereFinds(pnpm.cmd)), {
      command: process.execPath,
      commandArgs: [pnpm.file],
      shim: pnpm.cmd,
    });
    assert.deepEqual(whichOnPath("codex", "win32", {}, whereFinds(exe.cmd)), {
      command: exe.file,
      commandArgs: [],
      shim: exe.cmd,
    });
  } finally {
    await rm(pnpm.dir, { recursive: true, force: true });
    await rm(exe.dir, { recursive: true, force: true });
  }
});

test("whichOnPath still prefers a codex.exe on PATH over a readable shim", async () => {
  const { dir, cmd } = await shimDir(NPM_SHIM, "node_modules\\@openai\\codex\\bin\\codex.js");
  try {
    assert.equal(whichOnPath("codex", "win32", {}, whereFinds(cmd, "C:\\Codex\\codex.exe")), "C:\\Codex\\codex.exe");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveCodex probes the version through an npm shim's script, in a real process", async () => {
  const script = 'console.log("codex-cli 9.9.9 " + JSON.stringify(process.argv.slice(2)))';
  const { dir, cmd, file } = await shimDir(NPM_SHIM, "node_modules\\@openai\\codex\\bin\\codex.js", script);
  try {
    const resolved = resolveCodex({
      env: {},
      platform: "win32",
      homeDir: path.join(dir, "no-home"),
      lookupOnPath: (command, platform, env) => whichOnPath(command, platform, env, whereFinds(cmd)),
    });
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.commandArgs, [file]);
    assert.equal(resolved.source, "path");
    assert.equal(resolved.shim, cmd);
    assert.equal(resolved.version, "9.9.9");
    assert.deepEqual(resolved.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a CODEX_DELEGATE_COMMAND naming an npm shim runs the shim's script, in a real process", async () => {
  const script = 'console.log("codex-cli 9.9.9 " + JSON.stringify(process.argv.slice(2)))';
  const { dir, cmd, file } = await shimDir(NPM_SHIM, "node_modules\\@openai\\codex\\bin\\codex.js", script);
  try {
    const resolved = resolveCodex({
      env: { CODEX_DELEGATE_COMMAND: cmd },
      platform: "win32",
      homeDir: path.join(dir, "no-home"),
      lookupOnPath: () => null,
    });
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.commandArgs, [file]);
    assert.equal(resolved.source, "override");
    assert.equal(resolved.shim, cmd);
    assert.equal(resolved.version, "9.9.9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("whichOnPath retains non-Windows first-result behavior", () => {
  const command = whichOnPath("codex", "linux", {}, () => ({
    status: 0,
    stdout: "/usr/local/bin/codex\n/usr/bin/codex\n",
  }));

  assert.equal(command, "/usr/local/bin/codex");
});

test("a standalone release installed after the first call is picked up on the next", async () => {
  // `codex update` adds the new release and leaves the old one on disk. A stored path
  // that still existed kept the server on the old CLI, refusing its new models.
  const home = await mkdtemp(path.join(tmpdir(), "cdm-update-"));
  const releases = path.join(home, ".codex", "packages", "standalone", "releases");
  const install = async (version) => {
    const bin = path.join(releases, `${version}-x86_64-unknown-linux-musl`, "bin", "codex");
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, "#!/bin/sh\n", "utf8");
    return bin;
  };
  const opts = {
    env: {},
    platform: "linux",
    homeDir: home,
    runVersion: (command) => `codex-cli ${parseVersion(command).join(".")}`,
    lookupOnPath: () => null,
  };

  try {
    const oldBin = await install("0.164.0");
    assert.equal(resolveCodex(opts).command, oldBin);

    const newBin = await install("0.171.0");
    const resolved = resolveCodex(opts);
    assert.equal(resolved.command, newBin);
    assert.equal(resolved.version, "0.171.0");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a probe that ignores SIGTERM cannot outlive its own timeout", { timeout: 30_000 }, () => {
  // spawnSync blocks the event loop, so a probe that declines the kill freezes the
  // whole server: no progress, no cancel, no stdio. Measured, not argued — with the
  // default catchable SIGTERM this call never returns at all.
  const started = Date.now();
  const result = whichOnPath(
    "codex",
    process.platform,
    process.env,
    (_probe, _args, options) =>
      spawnSync(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"],
        { ...options, timeout: 400 }
      )
  );
  assert.equal(result, null);
  assert.ok(Date.now() - started < 15_000, "the probe outlived its timeout");
});
