import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRateLimits, describeUsage } from "../src/account.js";
import { runDoctor } from "../src/doctor.js";

/** The fields of a CLI 0.171.0 rateLimits/read answer that describeUsage reads. */
function rateLimits({ primary = 3, secondary = 4, reached = null, allowed = true, resetCredits = 1, credits } = {}) {
  return {
    ordinaryUsageAllowed: allowed,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1795627031 },
      secondary: { usedPercent: secondary, windowDurationMins: 10080, resetsAt: 1796151755 },
      credits: credits ?? { hasCredits: false, unlimited: false, balance: "0" },
      planType: "plus",
      rateLimitReachedType: reached,
    },
    rateLimitResetCredits: { availableCount: resetCredits, credits: [] },
  };
}

/** A node script standing in for `codex app-server`: answers initialize, then rateLimits/read. */
async function fakeAppServer(dir, { answer, silent = false }) {
  const script = path.join(dir, "codex.js");
  await writeFile(
    script,
    [
      "if (process.argv[2] !== 'app-server') process.exit(9);",
      `const silent = ${silent};`,
      `const answer = ${JSON.stringify(answer)};`,
      "let buf = '';",
      "process.stdin.on('data', (d) => {",
      "  buf += d; let i;",
      "  while ((i = buf.indexOf('\\n')) >= 0) {",
      "    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);",
      "    if (silent) continue;",
      "    if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: { userAgent: 'x' } }));",
      "    if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: m.id, ...answer }));",
      "  }",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8"
  );
  return { command: process.execPath, commandArgs: [script] };
}

test("readRateLimits reads the answer from a real app-server process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-account-"));
  try {
    const launcher = await fakeAppServer(dir, { answer: { result: rateLimits() } });
    const raw = await readRateLimits({ ...launcher, timeoutMs: 10_000 });
    assert.equal(raw.rateLimits.primary.usedPercent, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readRateLimits is null for an error answer and for a server that never answers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cdm-account-"));
  try {
    const erroring = await fakeAppServer(dir, { answer: { error: { code: -32600, message: "not a ChatGPT login" } } });
    assert.equal(await readRateLimits({ ...erroring, timeoutMs: 10_000 }), null);

    const silent = await fakeAppServer(dir, { answer: {}, silent: true });
    const started = Date.now();
    assert.equal(await readRateLimits({ ...silent, timeoutMs: 500 }), null);
    assert.ok(Date.now() - started < 5000, "the timeout bounds the wait");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("describeUsage labels each window by its length and keeps only what is set", () => {
  const warnings = [];
  assert.deepEqual(describeUsage(rateLimits(), warnings), {
    plan: "plus",
    windows: [
      { window: "5h", usedPercent: 3, resetsAt: "2026-11-25T17:17:11.000Z" },
      { window: "7d", usedPercent: 4, resetsAt: "2026-12-01T19:02:35.000Z" },
    ],
    resetCredits: 1,
  });
  assert.deepEqual(warnings, []);
  assert.equal("resetCredits" in describeUsage(rateLimits({ resetCredits: 0 }), []), false);
  assert.equal(describeUsage(null, warnings), null);
});

test("describeUsage warns on a window at 80% and on a reached limit", () => {
  const near = [];
  describeUsage(rateLimits({ primary: 80 }), near);
  assert.deepEqual(near, ["Codex 5h usage is at 80%; it resets at 2026-11-25T17:17:11.000Z."]);

  const reached = [];
  const out = describeUsage(rateLimits({ secondary: 100, reached: "weekly", allowed: false }), reached);
  assert.equal(out.limitReached, "weekly");
  assert.deepEqual(reached, [
    "Codex reports its weekly limit reached; delegations fail until it resets (2026-12-01T19:02:35.000Z).",
  ]);
});

test("doctor deep files the plan under auth and the windows under usage", async () => {
  const out = await runDoctor({
    deep: true,
    workspace: process.cwd(),
    env: {},
    resolve: () => ({ command: "/bin/codex", source: "standalone", version: "0.171.0", warnings: [] }),
    execFileImpl: async (_cmd, args) => (args.join(" ") === "login status"
      ? { stdout: "Logged in using ChatGPT", stderr: "" }
      : { stdout: "--json --output-last-message", stderr: "" }),
    readUsage: async () => rateLimits({ primary: 91 }),
  });

  assert.deepEqual(out.auth, { status: "ok", method: "chatgpt", plan: "plus" });
  assert.equal(out.usage.windows[0].usedPercent, 91);
  assert.equal("plan" in out.usage, false);
  assert.ok(out.warnings.some((w) => w.startsWith("Codex 5h usage is at 91%")));

  const unreadable = await runDoctor({
    deep: true,
    workspace: process.cwd(),
    env: {},
    resolve: () => ({ command: "/bin/codex", source: "standalone", version: "0.171.0", warnings: [] }),
    execFileImpl: async () => ({ stdout: "Logged in using ChatGPT --json --output-last-message", stderr: "" }),
    readUsage: async () => null,
  });
  assert.deepEqual(unreadable.usage, { ran: false, reason: "unreadable" });
  assert.equal("plan" in unreadable.auth, false);
});
