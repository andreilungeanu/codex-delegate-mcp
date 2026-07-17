import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  normalizeAgentReportedFiles,
  pathsFromFileChangeItem,
} from "../src/agent-reported-files.js";

test("pathsFromFileChangeItem extracts path strings", () => {
  assert.deepEqual(
    pathsFromFileChangeItem({
      type: "file_change",
      changes: [
        { path: "C:\\tmp\\a.txt", kind: "add" },
        { path: "C:\\tmp\\b.txt", kind: "update" },
        { path: "  ", kind: "add" },
        { kind: "delete" },
      ],
    }),
    ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"]
  );
  assert.deepEqual(pathsFromFileChangeItem(null), []);
  assert.deepEqual(pathsFromFileChangeItem({ changes: "nope" }), []);
});

test("normalizeAgentReportedFiles relativizes and dedupes", () => {
  const workspace = path.resolve("/repo");
  const files = normalizeAgentReportedFiles(
    [
      path.join(workspace, "src", "a.js"),
      path.join(workspace, "src", "a.js"),
      path.join(workspace, "src", "b.js"),
    ],
    workspace
  );
  assert.deepEqual(files, ["src/a.js", "src/b.js"]);
});
