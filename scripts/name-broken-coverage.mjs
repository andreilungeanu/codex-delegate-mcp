// Names each V8 coverage file in a directory that is not valid JSON, the file
// `--experimental-test-coverage` stops at with "Could not report code coverage". The name carries
// the writer's pid and write time, and the scripts listed before the cut name the process.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const dir = process.argv[2];
const names = readdirSync(dir);
let broken = 0;
for (const name of names) {
  const text = readFileSync(join(dir, name), "utf8");
  try {
    JSON.parse(text);
    continue;
  } catch (err) {
    broken++;
    const [, pid = "?", ms] = name.match(/^coverage-(\d+)-(\d+)-/) ?? [];
    const written = ms ? new Date(Number(ms)).toISOString() : "?";
    const scripts = [...new Set(text.match(/file:\/\/[^"]+/g) ?? [])].filter((url) => !url.includes("/node_modules/"));
    console.log(`${name}: ${text.length} bytes, pid ${pid}, written ${written}: ${/** @type {Error} */ (err).message}`);
    console.log(`  scripts: ${scripts.join(", ") || "none before the cut"}`);
  }
}
console.log(`${broken} of ${names.length} coverage files are not valid JSON`);
