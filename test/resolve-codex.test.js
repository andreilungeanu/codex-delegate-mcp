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
