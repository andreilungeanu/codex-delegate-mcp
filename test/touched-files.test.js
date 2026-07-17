import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelain, computeTouched } from "../src/touched-files.js";

test("parsePorcelain handles renames and paths", () => {
  const set = parsePorcelain(" M src/a.js\nR  old.js -> new.js\n", "/repo");
  assert.ok([...set].some((p) => p.replace(/\\/g, "/").endsWith("src/a.js")));
  assert.ok([...set].some((p) => p.replace(/\\/g, "/").endsWith("new.js")));
});

test("computeTouched returns only new paths", () => {
  const before = new Set(["/repo/a.js"]);
  const after = new Set(["/repo/a.js", "/repo/b.js"]);
  const { files, source } = computeTouched({
    before,
    after,
    workspace: "/repo",
  });
  assert.equal(source, "git");
  assert.deepEqual(files, ["b.js"]);
});
