import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  compareSemver,
  refreshCodex,
  resolveCodex,
  resolveCodexUncached,
  clearCodexCache,
  whichOnPath,
} from "../src/resolve-codex.js";

test("parseVersion and compareSemver", () => {
  assert.deepEqual(parseVersion("codex-cli 0.144.4"), [0, 144, 4]);
  assert.equal(compareSemver([0, 144, 0], [0, 143, 9]), 1);
  assert.equal(compareSemver([0, 144, 0], [0, 144, 0]), 0);
});

test("resolveCodexUncached uses override and version gate", () => {
  clearCodexCache();
  const resolved = resolveCodexUncached({
    env: { CODEX_DELEGATE_COMMAND: process.execPath },
    platform: "linux",
    homeDir: "/nonexistent-home",
    runVersion: () => "codex-cli 0.144.4",
  });
  assert.equal(resolved.source, "override");
  assert.equal(resolved.version, "0.144.4");
});

test("resolveCodexUncached rejects old versions", () => {
  clearCodexCache();
  assert.throws(
    () =>
      resolveCodexUncached({
        env: { CODEX_DELEGATE_COMMAND: process.execPath },
        platform: "linux",
        homeDir: "/nonexistent-home",
        runVersion: () => "codex-cli 0.100.0",
      }),
    /below required/
  );
});

test("resolveCodexUncached rejects relative override", () => {
  clearCodexCache();
  assert.throws(
    () =>
      resolveCodexUncached({
        env: { CODEX_DELEGATE_COMMAND: "codex" },
        platform: "linux",
        homeDir: "/nonexistent-home",
        runVersion: () => "codex-cli 0.144.4",
      }),
    (err) => err.code === "override_not_absolute"
  );
});

test("resolveCodexUncached not_found when no candidates", () => {
  clearCodexCache();
  assert.throws(
    () =>
      resolveCodexUncached({
        env: { PATH: "", Path: "" },
        platform: "win32",
        homeDir: "D:\\nonexistent-home-no-codex",
        lookupOnPath: () => null,
        runVersion: () => "codex-cli 0.144.4",
      }),
    (err) => err.code === "not_found"
  );
});

test("whichOnPath on Windows skips a .cmd shim in favor of codex.exe", () => {
  const command = whichOnPath("codex", "win32", {}, () => ({
    status: 0,
    stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\r\nC:\\Codex\\codex.EXE\r\n",
  }));

  assert.equal(command, "C:\\Codex\\codex.EXE");
});

test("resolveCodexUncached skips and warns about Windows PATH shims", () => {
  const pathLookup = whichOnPath("codex", "win32", {}, () => ({
    status: 0,
    stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\r\n",
  }));
  assert.deepEqual(pathLookup, { command: null, unusable: true });

  const resolved = resolveCodexUncached({
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

test("whichOnPath retains non-Windows first-result behavior", () => {
  const command = whichOnPath("codex", "linux", {}, () => ({
    status: 0,
    stdout: "/usr/local/bin/codex\n/usr/bin/codex\n",
  }));

  assert.equal(command, "/usr/local/bin/codex");
});

test("refreshCodex bypasses and updates the cache", () => {
  clearCodexCache();
  const options = {
    env: { CODEX_DELEGATE_COMMAND: process.execPath },
    platform: "linux",
    homeDir: "/nonexistent-home",
  };

  resolveCodex({ ...options, runVersion: () => "codex-cli 0.144.4" });
  const refreshed = refreshCodex({ ...options, runVersion: () => "codex-cli 0.144.5" });

  assert.equal(refreshed.version, "0.144.5");
  assert.equal(
    resolveCodex({ ...options, runVersion: () => "codex-cli 9.9.9" }).version,
    "0.144.5"
  );
  clearCodexCache();
});

test("refreshCodex clears the cache when its fresh probe fails", () => {
  clearCodexCache();
  const options = {
    env: { CODEX_DELEGATE_COMMAND: process.execPath },
    platform: "linux",
    homeDir: "/nonexistent-home",
  };

  resolveCodex({ ...options, runVersion: () => "codex-cli 0.144.4" });
  assert.throws(
    () => refreshCodex({ ...options, runVersion: () => "codex-cli 0.100.0" }),
    /below required/
  );

  assert.equal(
    resolveCodex({ ...options, runVersion: () => "codex-cli 0.144.6" }).version,
    "0.144.6"
  );
  clearCodexCache();
});
