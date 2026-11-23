// A stand-in for Codex that leaves something behind: it spawns a grandchild that
// ignores SIGTERM, reports that pid, and then either exits or lingers. The orphan
// case is the point — the leader is gone while the work it started is not.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const [pidFile, mode] = process.argv.slice(2);

// `node --test` collects every file under test/, this one included. Without the
// arguments a real run passes it is not a run at all, and spawning here would leak a
// process on every suite.
if (!pidFile) process.exit(0);

// "own-session" starts the grandchild in a session of its own, outside this process group, as Codex
// 0.170 starts each shell command on Linux, and the grandchild runs one command of its own, as the
// shell does, reporting its pid in <pidFile>.nested.
// "own-session-trigger" has that grandchild start a further session of its own once
// <pidFile>.trigger exists, reporting its pid in <pidFile>.late.
const ownSession = mode === "own-session" || mode === "own-session-trigger";
const nested = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(`${pidFile}.nested`)}, c.pid + "\\n");`;
const lateOnTrigger = `const w = setInterval(() => {
  if (!require("node:fs").existsSync(${JSON.stringify(`${pidFile}.trigger`)})) return;
  clearInterval(w);
  const l = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", detached: true });
  require("node:fs").writeFileSync(${JSON.stringify(`${pidFile}.late`)}, l.pid + "\\n");
}, 5);`;
const grandchildCode = { "own-session": nested, "own-session-trigger": lateOnTrigger }[mode] ?? "";
const grandchild = spawn(
  process.execPath,
  // Ignoring SIGTERM matters: the group kill is SIGKILL, and a grandchild that dies
  // on a polite signal would pass even if the kill never reached the group.
  ["-e", `${grandchildCode} process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);`],
  { stdio: "ignore", detached: ownSession }
);

// Enough JSONL to look like a healthy run, so a startup deadline is not what ends it.
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "tid-live" })}\n`);

writeFileSync(pidFile, `${grandchild.pid}\n`);

// "leader-exits" leaves the grandchild in the group with no live leader.
if (mode === "leader-exits") process.exit(0);
// "spawn-on-trigger" starts one more command in a session of its own once <pidFile>.trigger exists,
// and reports its pid in <pidFile>.late.
if (mode === "spawn-on-trigger") {
  const watch = setInterval(() => {
    if (!existsSync(`${pidFile}.trigger`)) return;
    clearInterval(watch);
    const late = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30);"], { stdio: "ignore", detached: true });
    writeFileSync(`${pidFile}.late`, `${late.pid}\n`);
  }, 5);
}
setInterval(() => {}, 1 << 30);
