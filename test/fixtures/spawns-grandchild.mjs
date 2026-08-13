// A stand-in for Codex that leaves something behind: it spawns a grandchild that
// ignores SIGTERM, reports that pid, and then either exits or lingers. The orphan
// case is the point — the leader is gone while the work it started is not.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile, mode] = process.argv.slice(2);

// `node --test` collects every file under test/, this one included. Without the
// arguments a real run passes it is not a run at all, and spawning here would leak a
// process on every suite.
if (!pidFile) process.exit(0);

const grandchild = spawn(
  process.execPath,
  // Ignoring SIGTERM matters: the group kill is SIGKILL, and a grandchild that dies
  // on a polite signal would pass even if the kill never reached the group.
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"],
  { stdio: "ignore" }
);

// Enough JSONL to look like a healthy run, so a startup deadline is not what ends it.
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "tid-live" })}\n`);

writeFileSync(pidFile, `${grandchild.pid}\n`);

// "leader-exits" leaves the grandchild in the group with no live leader.
if (mode === "leader-exits") process.exit(0);
setInterval(() => {}, 1 << 30);
