import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  compareSemver,
  resolveCodexUncached,
  clearCodexCache,
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
